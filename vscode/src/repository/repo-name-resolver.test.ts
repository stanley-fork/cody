import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    AUTH_STATUS_FIXTURE_AUTHED,
    AUTH_STATUS_FIXTURE_AUTHED_DOTCOM,
    CLIENT_CAPABILITIES_FIXTURE,
    firstResultFromOperation,
    graphqlClient,
    mockAuthStatus,
    mockClientCapabilities,
    mockResolvedConfig,
} from '@sourcegraph/cody-shared'

import * as configuration from '../configuration'

import { Uri } from 'vscode'
import * as vscode from 'vscode'
import * as remoteUrlsFromParentDirs from './remote-urls-from-parent-dirs'
import { RepoNameResolver, fakeGitURLFromCodebase } from './repo-name-resolver'
import { mockFsCalls } from './test-helpers'

describe('fakeGitURLFromCodebase', () => {
    it('returns undefined when codebaseName is undefined', () => {
        expect(fakeGitURLFromCodebase(undefined)).toBeUndefined()
    })

    it('returns the codebaseName as a URL string when it is a valid URL', () => {
        expect(fakeGitURLFromCodebase('https://github.com/sourcegraph/cody')).toBe(
            'https://github.com/sourcegraph/cody'
        )
    })

    it('converts a codebase name without a scheme to a git URL', () => {
        expect(fakeGitURLFromCodebase('example.com/foo/bar')).toBe('git@example.com:foo/bar')
    })

    it('handles a codebase name with multiple slashes', () => {
        expect(fakeGitURLFromCodebase('example.com/foo/bar/baz')).toBe('git@example.com:foo/bar/baz')
    })

    it('handles a codebase name with a single path component', () => {
        expect(fakeGitURLFromCodebase('example.com/foo')).toBe('git@example.com:foo')
    })
})

vi.mock('../services/AuthProvider')

describe('getRepoNamesContainingUri', () => {
    afterEach(() => {
        vi.resetAllMocks()
    })

    function prepareEnterpriseMocks(resolvedValue: string | null) {
        const repoNameResolver = new RepoNameResolver()
        mockAuthStatus(AUTH_STATUS_FIXTURE_AUTHED)
        mockResolvedConfig({ auth: {} })
        mockClientCapabilities(CLIENT_CAPABILITIES_FIXTURE)

        vi.spyOn(remoteUrlsFromParentDirs, 'gitRemoteUrlsForUri').mockResolvedValue([
            'git@github.com:sourcegraph/cody.git',
        ])

        const { fileUri } = mockFsCalls({
            filePath: '/repo/submodule/foo.ts',
            gitRepoPath: '/repo',
            gitConfig: `
                [core]
                    repositoryformatversion = 0
                    filemode = true
                [remote "origin"]
                    url = https://github.com/sourcegraph/cody.git
                    fetch = +refs/heads/*:refs/remotes/origin/*
            `,
        })

        const getRepoNameGraphQLMock = vi
            .spyOn(graphqlClient, 'getRepoName')
            .mockResolvedValue(resolvedValue)

        return {
            repoNameResolver,
            fileUri,
            getRepoNameGraphQLMock,
        }
    }
    it('resolves the repo name using graphql for enterprise accounts', async () => {
        const { repoNameResolver, fileUri, getRepoNameGraphQLMock } =
            prepareEnterpriseMocks('sourcegraph/cody')
        const repoNames = await firstResultFromOperation(
            repoNameResolver.getRepoNamesContainingUri(fileUri)
        )

        expect(repoNames).toEqual(['sourcegraph/cody'])
        expect(getRepoNameGraphQLMock).toBeCalledTimes(1)
    })

    it('reuses cached API responses that are needed to resolve enterprise repo names', async () => {
        const { repoNameResolver, fileUri, getRepoNameGraphQLMock } =
            prepareEnterpriseMocks('sourcegraph/cody')

        const repoNames = await firstResultFromOperation(
            repoNameResolver.getRepoNamesContainingUri(fileUri)
        )
        const shouldReuseCachedValue = await firstResultFromOperation(
            repoNameResolver.getRepoNamesContainingUri(fileUri)
        )

        expect(repoNames).toEqual(['sourcegraph/cody'])
        expect(shouldReuseCachedValue).toEqual(repoNames)
        expect(getRepoNameGraphQLMock).toBeCalledTimes(1)
    })

    it('resolves the repo name using local conversion function for PLG accounts', async () => {
        const repoNameResolver = new RepoNameResolver()
        mockAuthStatus(AUTH_STATUS_FIXTURE_AUTHED_DOTCOM)

        vi.spyOn(remoteUrlsFromParentDirs, 'gitRemoteUrlsForUri').mockResolvedValue([
            'git@github.com:sourcegraph/cody.git',
        ])

        const { fileUri } = mockFsCalls({
            filePath: '/repo/submodule/foo.ts',
            gitRepoPath: '/repo',
            gitConfig: `
                [core]
                    repositoryformatversion = 0
                    filemode = true
                [remote "origin"]
                    url = https://github.com/sourcegraph/cody.git
                    fetch = +refs/heads/*:refs/remotes/origin/*
            `,
        })

        const getRepoNameGraphQLMock = vi
            .spyOn(graphqlClient, 'getRepoName')
            .mockResolvedValue('sourcegraph/cody')

        expect(
            await firstResultFromOperation(repoNameResolver.getRepoNamesContainingUri(fileUri))
        ).toEqual(['github.com/sourcegraph/cody'])
        expect(getRepoNameGraphQLMock).not.toBeCalled()
    })

    it('resolves the repo name using local conversion function if no value found on server', async () => {
        const { repoNameResolver, fileUri, getRepoNameGraphQLMock } = prepareEnterpriseMocks(null)
        const repoNames = await firstResultFromOperation(
            repoNameResolver.getRepoNamesContainingUri(fileUri)
        )

        expect(repoNames).toEqual(['github.com/sourcegraph/cody'])
        expect(getRepoNameGraphQLMock).toBeCalledTimes(1)
    })

    it('resolves the repo name repo: workspace folders if any', async () => {
        vi.spyOn(vscode.workspace, 'getWorkspaceFolder').mockReturnValue({
            uri: Uri.parse('repo:my/repo'),
            name: 'repo',
            index: 0,
        })

        const repoNameResolver = new RepoNameResolver()
        mockAuthStatus(AUTH_STATUS_FIXTURE_AUTHED)

        const file = Uri.parse('repo:my/repo/my/file.txt')
        expect(await firstResultFromOperation(repoNameResolver.getRepoNamesContainingUri(file))).toEqual(
            ['my/repo']
        )
    })

    it('prioritizes configured codebase over repository detection', async () => {
        const repoNameResolver = new RepoNameResolver()
        mockAuthStatus(AUTH_STATUS_FIXTURE_AUTHED_DOTCOM)

        vi.spyOn(remoteUrlsFromParentDirs, 'gitRemoteUrlsForUri').mockResolvedValue([
            'git@github.com:sourcegraph/cody.git',
        ])

        vi.spyOn(configuration, 'getConfiguration').mockReturnValue({
            codebase: 'github.com/custom/repo',
        } as any)

        const { fileUri } = mockFsCalls({
            filePath: '/repo/file.ts',
            gitRepoPath: '/repo',
            gitConfig: `
                [core]
                    repositoryformatversion = 0
                    filemode = true
                [remote "origin"]
                    url = git@github.com:sourcegraph/cody.git
                    fetch = +refs/heads/*:refs/remotes/origin/*
            `,
        })

        expect(
            await firstResultFromOperation(repoNameResolver.getRepoNamesContainingUri(fileUri))
        ).toEqual(['github.com/custom/repo'])
    })

    it('handles HTTPS URL in codebase configuration', async () => {
        const repoNameResolver = new RepoNameResolver()
        mockAuthStatus(AUTH_STATUS_FIXTURE_AUTHED_DOTCOM)

        vi.spyOn(configuration, 'getConfiguration').mockReturnValue({
            codebase: 'https://github.com/custom/repo',
        } as any)

        const { fileUri } = mockFsCalls({
            filePath: '/repo/file.ts',
            gitRepoPath: '/repo',
            gitConfig: '',
        })

        expect(
            await firstResultFromOperation(repoNameResolver.getRepoNamesContainingUri(fileUri))
        ).toEqual(['github.com/custom/repo'])
    })
})
