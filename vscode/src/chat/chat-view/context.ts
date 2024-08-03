import * as vscode from 'vscode'

import {
    type ConfigurationUseContext,
    type ContextItem,
    type ContextItemRepository,
    ContextItemSource,
    type ContextItemTree,
    FeatureFlag,
    MAX_BYTES_PER_FILE,
    NUM_CODE_RESULTS,
    NUM_TEXT_RESULTS,
    type PromptString,
    type Result,
    featureFlagProvider,
    graphqlClient,
    isFileURI,
    truncateTextNearestLine,
    uriBasename,
    wrapInActiveSpan,
} from '@sourcegraph/cody-shared'
import { compact, flatten, isError, zip } from 'lodash'
import type { RemoteSearch } from '../../context/remote-search'
import type { VSCodeEditor } from '../../editor/vscode-editor'
import type { LocalEmbeddingsController } from '../../local-context/local-embeddings'
import type { SymfRunner } from '../../local-context/symf'
import { logDebug, logError } from '../../log'
import { repoNameResolver } from '../../repository/repo-name-resolver'

export interface HumanInput {
    text: PromptString
    mentions: ContextItem[]
}

/**
 * A Root instance represents the root of a codebase.
 *
 * If the codebase exists locally, then the `local` property indicates where in the local filesystem the
 * codebase exists.
 * If the codebase exists remotely on Sourcegraph, then the `remoteRepo` property indicates the name of the
 * remote repository and its ID.
 *
 * It is possible for both fields to be set, if the codebase exists on Sourcegraph and is checked out locally.
 */
export interface Root {
    local?: vscode.Uri
    remoteRepo?: {
        name: string
        id: string
    }
}

/**
 * Returns the set of codebase roots extracted from the human input.
 */
export async function codebaseRootsFromHumanInput(input: HumanInput): Promise<Root[]> {
    const remoteRepos: Root[] = input.mentions
        .filter((item): item is ContextItemRepository => item.type === 'repository')
        .map(repo => ({
            remoteRepo: {
                id: repo.repoID,
                name: repo.repoName,
            },
        }))

    const localTrees: ContextItemTree[] = input.mentions.filter(
        (item): item is ContextItemTree => item.type === 'tree'
    )
    const groups = await Promise.all(
        localTrees.map(async tree => {
            const repoURIs = await repoNameResolver.getRepoNamesFromWorkspaceUri(tree.uri)
            return repoURIs.map(repoURI => ({
                repoURI,
                local: tree.uri,
            }))
        })
    )
    const localRepoURIs = Array.from(new Set(groups.flat()))
    const localRepoIDs = await graphqlClient.getRepoIds(
        localRepoURIs.map(({ repoURI }) => repoURI),
        localRepoURIs.length
    )
    if (isError(localRepoIDs)) {
        throw localRepoIDs
    }
    const uriToId: { [uri: string]: string } = {}
    for (const r of localRepoIDs) {
        uriToId[r.name] = r.id
    }
    const localRoots: Root[] = []
    for (const repoWithURI of localRepoURIs) {
        localRoots.push({
            local: repoWithURI.local,
            remoteRepo: {
                id: uriToId[repoWithURI.repoURI],
                name: repoWithURI.repoURI,
            },
        })
    }

    return [...remoteRepos, ...localRoots]
}

export function remoteRepositoryIDsFromHumanInput(input: HumanInput): string[] {
    return input.mentions
        .filter((item): item is ContextItemRepository => item.type === 'repository')
        .map(repo => repo.repoID)
}

export async function remoteRepositoryURIsForLocalTrees(input: HumanInput): Promise<string[]> {
    const trees: ContextItemTree[] = input.mentions.filter(
        (item): item is ContextItemTree => item.type === 'tree'
    )

    const groups = await Promise.all(
        trees.map(tree => repoNameResolver.getRepoNamesFromWorkspaceUri(tree.uri))
    )
    return Array.from(new Set(groups.flat()))
}

function shouldSearchInLocalWorkspace(input: HumanInput): boolean {
    return input.mentions.some(item => item.type === 'tree')
}

interface GetEnhancedContextOptions {
    strategy: ConfigurationUseContext
    editor: VSCodeEditor
    input: HumanInput
    providers: {
        localEmbeddings: LocalEmbeddingsController | null
        symf: SymfRunner | null
        remoteSearch: RemoteSearch | null
    }
    addEnhancedContext: boolean
    // TODO(@philipp-spiess): Add abort controller to be able to cancel expensive retrievers
}
export async function getEnhancedContext({
    strategy,
    editor,
    input,
    providers,
    addEnhancedContext,
}: GetEnhancedContextOptions): Promise<ContextItem[]> {
    return wrapInActiveSpan('chat.enhancedContext', async () => {
        // use user attention context only if config is set to none
        if (strategy === 'none') {
            logDebug('ChatController', 'getEnhancedContext > none')
            return getVisibleEditorContext(editor)
        }

        const embeddingsContextItemsPromise =
            strategy !== 'keyword' && (addEnhancedContext || shouldSearchInLocalWorkspace(input))
                ? retrieveContextGracefully(
                      searchEmbeddingsLocal(providers.localEmbeddings, input.text),
                      'local-embeddings'
                  )
                : []

        //  Get search (symf or remote search) context if config is not set to 'embeddings' only
        const remoteSearchContextItemsPromise =
            providers.remoteSearch && strategy !== 'embeddings'
                ? retrieveContextGracefully(
                      searchRemote(providers.remoteSearch, input, addEnhancedContext),
                      'remote-search'
                  )
                : []
        const localSearchContextItemsPromise =
            providers.symf &&
            strategy !== 'embeddings' &&
            (addEnhancedContext || shouldSearchInLocalWorkspace(input))
                ? retrieveContextGracefully(searchSymf(providers.symf, editor, input.text), 'symf')
                : []

        // Retrieve items from all context sources
        const searchContextBySource = [
            await embeddingsContextItemsPromise,
            await remoteSearchContextItemsPromise,
            await localSearchContextItemsPromise,
        ]

        // Interleave items from context sources, excluding undefined items inserted by lodash's zip
        const searchContext = compact(flatten(zip(...searchContextBySource)))

        const priorityContext = await getPriorityContext(input.text, editor, searchContext)
        return priorityContext.concat(searchContext)
    })
}

export async function getContextStrategy(
    defaultStrategy: ConfigurationUseContext
): Promise<ConfigurationUseContext> {
    // Only run experiment if we're in VS Code
    if (vscode.workspace.getConfiguration().get<boolean>('cody.advanced.agent.running', false)) {
        return defaultStrategy
    }

    const [isEnhancedContextExperiment, useEmbeddings, useSymf] = await Promise.all([
        featureFlagProvider.evaluateFeatureFlag(FeatureFlag.CodyEnhancedContextExperiment),
        featureFlagProvider.evaluateFeatureFlag(FeatureFlag.CodyEnhancedContexUseEmbeddings),
        featureFlagProvider.evaluateFeatureFlag(FeatureFlag.CodyEnhancedContextUseSymf),
    ])

    if (!isEnhancedContextExperiment) {
        return defaultStrategy
    }

    if (useEmbeddings && useSymf) {
        return 'blended'
    }
    if (useEmbeddings) {
        return 'embeddings'
    }
    if (useSymf) {
        return 'keyword'
    }
    return 'none'
}

async function searchRemote(
    remoteSearch: RemoteSearch | null,
    input: HumanInput,
    allReposForEnhancedContext: boolean
): Promise<ContextItem[]> {
    return wrapInActiveSpan('chat.context.search.remote', async () => {
        if (!remoteSearch) {
            return []
        }
        const repoIDs = allReposForEnhancedContext
            ? remoteSearch.getRepoIdSet()
            : remoteRepositoryIDsFromHumanInput(input)
        return (await remoteSearch.query(input.text, repoIDs)).map(result => {
            return {
                type: 'file',
                content: result.content,
                range: new vscode.Range(result.startLine, 0, result.endLine, 0),
                uri: result.uri,
                source: ContextItemSource.Unified,
                repoName: result.repoName,
                title: result.path,
                revision: result.commit,
            } satisfies ContextItem
        })
    })
}

/**
 * Uses symf to conduct a local search within the current workspace folder
 */
async function searchSymf(
    symf: SymfRunner | null,
    editor: VSCodeEditor,
    userText: PromptString,
    blockOnIndex = false
): Promise<ContextItem[]> {
    return wrapInActiveSpan('chat.context.symf', async () => {
        if (!symf) {
            return []
        }
        const workspaceRoot = editor.getWorkspaceRootUri()
        if (!workspaceRoot || !isFileURI(workspaceRoot)) {
            return []
        }

        const indexExists = await symf.getIndexStatus(workspaceRoot)
        if (indexExists !== 'ready' && !blockOnIndex) {
            void symf.ensureIndex(workspaceRoot, {
                retryIfLastAttemptFailed: false,
                ignoreExisting: false,
            })
            return []
        }

        // trigger background reindex if the index is stale
        void symf?.reindexIfStale(workspaceRoot)

        const r0 = (await symf.getResults(userText, [workspaceRoot])).flatMap(async results => {
            const items = (await results).flatMap(
                async (result: Result): Promise<ContextItem[] | ContextItem> => {
                    const range = new vscode.Range(
                        result.range.startPoint.row,
                        result.range.startPoint.col,
                        result.range.endPoint.row,
                        result.range.endPoint.col
                    )

                    let text: string | undefined
                    try {
                        text = await editor.getTextEditorContentForFile(result.file, range)
                    } catch (error) {
                        logError('ChatController.searchSymf', `Error getting file contents: ${error}`)
                        return []
                    }
                    return {
                        type: 'file',
                        uri: result.file,
                        range,
                        source: ContextItemSource.Search,
                        content: text,
                    }
                }
            )
            return (await Promise.all(items)).flat()
        })

        return (await Promise.all(r0)).flat()
    })
}

async function searchEmbeddingsLocal(
    localEmbeddings: LocalEmbeddingsController | null,
    text: PromptString,
    numResults: number = NUM_CODE_RESULTS + NUM_TEXT_RESULTS
): Promise<ContextItem[]> {
    return wrapInActiveSpan('chat.context.embeddings.local', async span => {
        if (!localEmbeddings) {
            return []
        }

        logDebug('ChatController', 'getEnhancedContext > searching local embeddings')
        const contextItems: ContextItem[] = []
        const embeddingsResults = await localEmbeddings.getContext(text, numResults)
        span.setAttribute('numResults', embeddingsResults.length)

        for (const result of embeddingsResults) {
            const range = new vscode.Range(
                new vscode.Position(result.startLine, 0),
                new vscode.Position(result.endLine, 0)
            )

            contextItems.push({
                type: 'file',
                uri: result.uri,
                range,
                content: result.content,
                source: ContextItemSource.Embeddings,
            })
        }
        return contextItems
    })
}

const userAttentionRegexps: RegExp[] = [
    /editor/,
    /(open|current|this|entire)\s+file/,
    /current(ly)?\s+open/,
    /have\s+open/,
]

function getVisibleEditorContext(editor: VSCodeEditor): ContextItem[] {
    return wrapInActiveSpan('chat.context.visibleEditorContext', () => {
        const visible = editor.getActiveTextEditorVisibleContent()
        const fileUri = visible?.fileUri
        if (!visible || !fileUri) {
            return []
        }
        if (!visible.content.trim()) {
            return []
        }
        return [
            {
                type: 'file',
                content: visible.content,
                uri: fileUri,
                source: ContextItemSource.Editor,
            },
        ] satisfies ContextItem[]
    })
}

async function getPriorityContext(
    text: PromptString,
    editor: VSCodeEditor,
    retrievedContext: ContextItem[]
): Promise<ContextItem[]> {
    return wrapInActiveSpan('chat.context.priority', async () => {
        const priorityContext: ContextItem[] = []
        if (needsUserAttentionContext(text)) {
            // Query refers to current editor
            priorityContext.push(...getVisibleEditorContext(editor))
        } else if (needsReadmeContext(editor, text)) {
            // Query refers to project, so include the README
            let containsREADME = false
            for (const contextItem of retrievedContext) {
                const basename = uriBasename(contextItem.uri)
                if (
                    basename.toLocaleLowerCase() === 'readme' ||
                    basename.toLocaleLowerCase().startsWith('readme.')
                ) {
                    containsREADME = true
                    break
                }
            }
            if (!containsREADME) {
                priorityContext.push(...(await getReadmeContext()))
            }
        }
        return priorityContext
    })
}

function needsUserAttentionContext(input: PromptString): boolean {
    const inputLowerCase = input.toString().toLowerCase()
    // If the input matches any of the `editorRegexps` we assume that we have to include
    // the editor context (e.g., currently open file) to the overall message context.
    for (const regexp of userAttentionRegexps) {
        if (inputLowerCase.match(regexp)) {
            return true
        }
    }
    return false
}

function needsReadmeContext(editor: VSCodeEditor, input: PromptString): boolean {
    const stringInput = input.toString().toLowerCase()
    const question = extractQuestion(stringInput)
    if (!question) {
        return false
    }

    // split input into words, discarding spaces and punctuation
    const words = stringInput.split(/\W+/).filter(w => w.length > 0)
    const bagOfWords = Object.fromEntries(words.map(w => [w, true]))

    let containsProjectSignifier = false
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name
    if (workspaceName && stringInput.includes('@' + workspaceName)) {
        containsProjectSignifier = true
    } else {
        const projectSignifiers = [
            'project',
            'repository',
            'repo',
            'library',
            'package',
            'module',
            'codebase',
        ]
        for (const p of projectSignifiers) {
            if (bagOfWords[p]) {
                containsProjectSignifier = true
                break
            }
        }
    }

    let containsQuestionIndicator = false
    for (const q of ['what', 'how', 'describe', 'explain']) {
        if (bagOfWords[q]) {
            containsQuestionIndicator = true
            break
        }
    }

    return containsQuestionIndicator && containsProjectSignifier
}
async function getReadmeContext(): Promise<ContextItem[]> {
    // global pattern for readme file
    const readmeGlobalPattern = '{README,README.,readme.,Readm.}*'
    const readmeUri = (await vscode.workspace.findFiles(readmeGlobalPattern, undefined, 1)).at(0)
    if (!readmeUri?.path) {
        return []
    }
    const readmeDoc = await vscode.workspace.openTextDocument(readmeUri)
    const readmeText = readmeDoc.getText()
    const { truncated: truncatedReadmeText, range } = truncateTextNearestLine(
        readmeText,
        MAX_BYTES_PER_FILE
    )
    if (truncatedReadmeText.length === 0) {
        return []
    }

    return [
        {
            type: 'file',
            uri: readmeUri,
            content: truncatedReadmeText,
            range,
            source: ContextItemSource.Editor,
        },
    ]
}

function extractQuestion(input: string): string | undefined {
    input = input.trim()
    const q = input.indexOf('?')
    if (q !== -1) {
        return input.slice(0, q + 1).trim()
    }
    if (input.length < 100) {
        return input
    }
    return undefined
}

async function retrieveContextGracefully<T>(promise: Promise<T[]>, strategy: string): Promise<T[]> {
    try {
        logDebug('ChatController', `getEnhancedContext > ${strategy} (start)`)
        return await promise
    } catch (error) {
        logError('ChatController', `getEnhancedContext > ${strategy}' (error)`, error)
        return []
    } finally {
        logDebug('ChatController', `getEnhancedContext > ${strategy} (end)`)
    }
}
