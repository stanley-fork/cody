import { SpanStatusCode } from '@opentelemetry/api'

import {
    type BrowserOrNodeResponse,
    type CodeCompletionProviderOptions,
    type CodeCompletionsClient,
    type CodeCompletionsParams,
    type CompletionResponse,
    type CompletionResponseGenerator,
    type CompletionResponseWithMetaData,
    CompletionStopReason,
    FeatureFlag,
    NetworkError,
    RateLimitError,
    type SerializedCodeCompletionsParams,
    TracedError,
    addAuthHeaders,
    addCodyClientIdentificationHeaders,
    addTraceparent,
    contextFiltersProvider,
    createSSEIterator,
    currentResolvedConfig,
    currentSiteVersion,
    featureFlagProvider,
    fetch,
    getActiveTraceAndSpanId,
    getClientInfoParams,
    isAbortError,
    isCustomAuthChallengeResponse,
    isError,
    isNodeResponse,
    isRateLimitError,
    logResponseHeadersToSpan,
    recordErrorToSpan,
    setJSONAcceptContentTypeHeaders,
    setSingleton,
    singletonNotYetSet,
    tracer,
} from '@sourcegraph/cody-shared'

import { getClientIdentificationHeaders } from '@sourcegraph/cody-shared'
import { NeedsAuthChallengeError } from '@sourcegraph/cody-shared/src/sourcegraph-api/errors'
import { autocompleteLifecycleOutputChannelLogger } from './output-channel-logger'

/**
 * Access the code completion LLM APIs via a Sourcegraph server instance.
 */
class DefaultCodeCompletionsClient implements CodeCompletionsClient {
    public logger = autocompleteLifecycleOutputChannelLogger

    public async complete(
        params: CodeCompletionsParams,
        abortController: AbortController,
        providerOptions?: CodeCompletionProviderOptions
    ): Promise<CompletionResponseGenerator> {
        const { auth, configuration } = await currentResolvedConfig()

        const query = new URLSearchParams(getClientInfoParams())
        const siteVersion = await currentSiteVersion()
        if (isError(siteVersion)) {
            throw siteVersion
        }

        query.append('api-version', String(siteVersion.codyAPIVersion))

        const url = new URL(`/.api/completions/code?${query.toString()}`, auth.serverEndpoint)
        const log = autocompleteLifecycleOutputChannelLogger?.startCompletion(params, url.href)
        const { signal } = abortController

        return tracer.startActiveSpan(
            `POST ${url}`,
            async function* (span): CompletionResponseGenerator {
                const traceId = getActiveTraceAndSpanId()?.traceId

                let result: CompletionResponseWithMetaData = {
                    completionResponse: undefined,
                    metadata: {},
                }

                try {
                    const tracingFlagEnabled = await featureFlagProvider.evaluateFeatureFlagEphemerally(
                        FeatureFlag.CodyAutocompleteTracing
                    )

                    const headers = new Headers({
                        ...configuration.customHeaders,
                        ...providerOptions?.customHeaders,
                        ...getClientIdentificationHeaders(),
                    })

                    setJSONAcceptContentTypeHeaders(headers)
                    addCodyClientIdentificationHeaders(headers)

                    if (tracingFlagEnabled) {
                        headers.set('X-Sourcegraph-Should-Trace', '1')
                        addTraceparent(headers)
                    }

                    await addAuthHeaders(auth, headers, url)

                    // Convert Headers to Record<string, string> for requestHeaders
                    const requestHeaders: Record<string, string> = {}
                    headers.forEach((value, key) => {
                        requestHeaders[key] = value
                    })

                    // We enable streaming only for Node environments right now because it's hard to make
                    // the polyfilled fetch API work the same as it does in the browser.
                    //
                    // TODO(philipp-spiess): Feature test if the response is a Node or a browser stream and
                    // implement SSE parsing for both.
                    const isNode = typeof process !== 'undefined'
                    const enableStreaming = !!isNode
                    span.setAttribute('enableStreaming', enableStreaming)

                    // Disable gzip compression since the sg instance will start to batch
                    // responses afterwards.
                    if (enableStreaming) {
                        headers.set('Accept-Encoding', 'gzip;q=0')
                    }

                    headers.set('X-Timeout-Ms', params.timeoutMs.toString())

                    const serializedParams: SerializedCodeCompletionsParams & {
                        stream: boolean
                    } = {
                        ...params,
                        stream: enableStreaming,
                        messages: await Promise.all(
                            params.messages.map(async m => ({
                                ...m,
                                text: await m.text?.toFilteredString(contextFiltersProvider),
                            }))
                        ),
                    }

                    log.onFetch('defaultClient', serializedParams)

                    const response = await fetch(url, {
                        method: 'POST',
                        body: JSON.stringify(serializedParams),
                        headers,
                        signal,
                    })

                    logResponseHeadersToSpan(span, response)

                    // When rate-limiting occurs, the response is an error message
                    if (response.status === 429) {
                        // Check for explicit false, because if the header is not set, there is no upgrade
                        // available.
                        //
                        // Note: This header is added only via the Sourcegraph instance and thus not added by
                        //       the helper function.
                        const upgradeIsAvailable =
                            response.headers.get('x-is-cody-pro-user') === 'false' &&
                            typeof response.headers.get('x-is-cody-pro-user') !== 'undefined'
                        throw await createRateLimitErrorFromResponse(response, upgradeIsAvailable)
                    }

                    if (!response.ok) {
                        throw isCustomAuthChallengeResponse(response)
                            ? new NeedsAuthChallengeError()
                            : new NetworkError(response, await response.text(), traceId)
                    }

                    if (response.body === null) {
                        throw new TracedError('No response body', traceId)
                    }

                    // For backward compatibility, we have to check if the response is an SSE stream or a
                    // regular JSON payload. This ensures that the request also works against older backends
                    const isStreamingResponse =
                        response.headers.get('content-type') === 'text/event-stream'

                    result = {
                        completionResponse: undefined,
                        metadata: {
                            response,
                            requestHeaders,
                            requestUrl: url.toString(),
                            requestBody: serializedParams,
                            isAborted: false,
                        },
                    }

                    if (isStreamingResponse && isNodeResponse(response)) {
                        const iterator = createSSEIterator(response.body, {
                            // Disable aggregatedCompletionEvent for deltaText format (API v2+)
                            // since we need all completion events to accumulate the text properly
                            aggregatedCompletionEvent: siteVersion.codyAPIVersion < 2,
                        })
                        let chunkIndex = 0

                        let completionText = ''
                        for await (const { event, data } of iterator) {
                            if (event === 'error') {
                                throw new TracedError(data, traceId)
                            }

                            if (signal.aborted) {
                                if (result.completionResponse) {
                                    result.completionResponse.stopReason =
                                        CompletionStopReason.RequestAborted
                                }

                                if (result.metadata) {
                                    result.metadata.isAborted = true
                                }

                                break
                            }

                            if (event === 'completion') {
                                const parsed = JSON.parse(data) as CompletionResponse
                                // delta_text is supported for V2 and above
                                // Doc: https://sourcegraph.sourcegraph.com/github.com/sourcegraph/sourcegraph/-/blob/internal/openapi/goapi/model_completion_response.go?L6-16
                                if (siteVersion.codyAPIVersion >= 2) {
                                    completionText += parsed.deltaText || ''
                                } else {
                                    completionText = parsed.completion || ''
                                }
                                result.completionResponse = {
                                    completion: completionText,
                                    stopReason: parsed.stopReason || CompletionStopReason.StreamingChunk,
                                }

                                span.addEvent('yield', {
                                    charCount: result.completionResponse.completion.length,
                                    stopReason: result.completionResponse.stopReason,
                                })

                                yield result
                            }

                            chunkIndex += 1
                        }

                        if (result.completionResponse === undefined) {
                            throw new TracedError('No completion response received', traceId)
                        }

                        if (
                            !result.completionResponse.stopReason ||
                            result.completionResponse.stopReason === CompletionStopReason.StreamingChunk
                        ) {
                            result.completionResponse.stopReason = CompletionStopReason.RequestFinished
                        }

                        yield result
                        return
                    }

                    // Handle non-streaming response
                    const text = await response.text()
                    result.completionResponse = JSON.parse(text) as CompletionResponse

                    if (
                        typeof result.completionResponse.completion !== 'string' ||
                        typeof result.completionResponse.stopReason !== 'string'
                    ) {
                        const message = `response does not satisfy CodeCompletionResponse: ${text}`
                        log?.onError(message)
                        throw new TracedError(message, traceId)
                    }

                    yield result
                    return
                } catch (error) {
                    // Shared error handling for both streaming and non-streaming requests.

                    if (isAbortError(error as Error)) {
                        // In case of the abort error and non-empty completion response, we can
                        // consider the completion partially completed and want to log it to
                        // the Cody output channel via `log.onComplete()` instead of erroring.
                        if (result.completionResponse) {
                            result.completionResponse.stopReason = CompletionStopReason.RequestAborted
                        }

                        if (result.metadata) {
                            result.metadata.isAborted = true
                        }

                        yield result
                        return
                    }

                    recordErrorToSpan(span, error as Error)

                    if (isRateLimitError(error as Error)) {
                        throw error
                    }

                    const message = `error parsing CodeCompletionResponse: ${error}`
                    log?.onError(message, error)
                    throw new TracedError(message, traceId)
                } finally {
                    if (result.completionResponse) {
                        span.addEvent('return', {
                            charCount: result.completionResponse.completion.length,
                            stopReason: result.completionResponse.stopReason,
                        })
                        span.setStatus({ code: SpanStatusCode.OK })
                        span.end()
                        log?.onComplete(result.completionResponse)
                    }
                }
            }
        )
    }
}

export const defaultCodeCompletionsClient = singletonNotYetSet<DefaultCodeCompletionsClient>()
setSingleton(defaultCodeCompletionsClient, new DefaultCodeCompletionsClient())

export async function createRateLimitErrorFromResponse(
    response: BrowserOrNodeResponse,
    upgradeIsAvailable: boolean
): Promise<RateLimitError> {
    const retryAfter = response.headers.get('retry-after')
    const limit = response.headers.get('x-ratelimit-limit')

    return new RateLimitError(
        'autocompletions',
        await response.text(),
        upgradeIsAvailable,
        limit ? Number.parseInt(limit, 10) : undefined,
        retryAfter
    )
}
