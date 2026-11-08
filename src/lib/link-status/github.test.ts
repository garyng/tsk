import { GraphqlResponseError } from '@octokit/graphql';
import { describe, expect, it } from 'vitest';
import {
    githubConnector,
    githubItem,
    itemsQuery,
    NOT_SIGNED_IN,
    statusOf,
    waitUntil,
} from './github';
import { RateLimited } from './queue';

describe('githubItem', () => {
    it("takes a PR's or an issue's link, whatever follows its number", () => {
        expect(githubItem('https://github.com/o/r-1.x/pull/12/files#diff-1')).toEqual({
            url: 'https://github.com/o/r-1.x/pull/12',
            ref: 'o/r-1.x#12',
        });
        expect(githubItem('https://github.com/o/r/issues/3?x=1')?.url).toBe(
            'https://github.com/o/r/issues/3',
        );
        for (const other of [
            'https://github.com/o/r',
            'https://github.com/o/r/pulls',
            'https://gitlab.com/o/r/pull/1',
        ])
            expect(githubItem(other)).toBeUndefined();
    });
});

describe('itemsQuery', () => {
    it('asks for each link by a variable, never by its text in the query', () => {
        const q = itemsQuery(2);
        expect(q).toMatch(/^query\(\$u0: URI!, \$u1: URI!\) \{/);
        expect(q).toContain('r1: resource(url: $u1)');
        expect(q).toContain('prState: state');
        expect(q).toContain('issueState: state');
    });
});

describe('statusOf', () => {
    const pr = (fields: object) =>
        statusOf(
            { __typename: 'PullRequest', title: 'Fix it', author: { login: 'gary' }, ...fields },
            'o/r#1',
        );
    const rollup = (state: string) => ({
        commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] },
    });

    it("reads a PR's state, its checks and, while open, its review", () => {
        expect(
            pr({
                prState: 'OPEN',
                isDraft: false,
                reviewDecision: 'CHANGES_REQUESTED',
                ...rollup('FAILURE'),
            }),
        ).toEqual({
            label: 'open',
            category: 'open',
            title: 'Fix it',
            checks: 'failing',
            lines: ['o/r#1 · @gary', 'changes requested'],
        });
        expect(pr({ prState: 'OPEN', isDraft: true, ...rollup('EXPECTED') })).toMatchObject({
            label: 'draft',
            checks: 'pending',
        });
        expect(
            pr({ prState: 'MERGED', reviewDecision: 'APPROVED', ...rollup('SUCCESS') }),
        ).toMatchObject({
            label: 'merged',
            category: 'done',
            checks: 'passing',
            lines: ['o/r#1 · @gary'],
        });
        expect(pr({ prState: 'CLOSED', commits: { nodes: [] } })).toMatchObject({
            label: 'closed',
            category: 'closed',
        });
        expect(pr({ prState: 'CLOSED' })).not.toHaveProperty('checks');
    });

    it('reads an issue: closed as completed is done, not planned is closed', () => {
        const issue = (fields: object) => statusOf({ __typename: 'Issue', ...fields }, 'o/r#2');
        expect(issue({ issueState: 'OPEN' })).toEqual({
            label: 'open',
            category: 'open',
            lines: ['o/r#2'],
        });
        expect(issue({ issueState: 'CLOSED', stateReason: 'COMPLETED' })).toMatchObject({
            category: 'done',
        });
        expect(issue({ issueState: 'CLOSED', stateReason: 'NOT_PLANNED' })).toMatchObject({
            category: 'closed',
        });
    });

    it('says why there is no status', () => {
        expect(statusOf(null, 'o/r#9')).toEqual({ error: 'o/r#9 not found, or no access to it' });
        expect(statusOf({ __typename: 'Commit' }, 'o/r#9')).toEqual({
            error: 'o/r#9 is a Commit, not a PR or an issue',
        });
    });
});

describe('waitUntil', () => {
    it("reads GitHub's retry-after, else the reset of a spent limit", () => {
        expect(waitUntil({ 'retry-after': '30' }, 1000)).toBe(31_000);
        expect(waitUntil({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000' }, 0)).toBe(
            2_000_000,
        );
        expect(
            waitUntil({ 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': '2000' }, 0),
        ).toBeUndefined();
        expect(waitUntil(undefined, 0)).toBeUndefined();
    });
});

describe('githubConnector', () => {
    const urls = [
        'https://github.com/o/r/pull/1',
        'https://github.com/o/r/issues/2/',
        'https://github.com/o/r/pull/3',
    ];
    const signal = new AbortController().signal;
    const connector = (
        graphql: (query: string, options: Record<string, unknown>) => Promise<unknown>,
        token = 'tok',
    ) =>
        githubConnector({
            token: async () => token || undefined,
            graphql: graphql as never,
            now: () => 0,
        });

    it('asks for every link in one query, with the session token, and answers each by its URL', async () => {
        const asked: Record<string, unknown>[] = [];
        const c = connector(async (_q, options) => {
            asked.push(options);
            return {
                r0: { __typename: 'PullRequest', prState: 'MERGED' },
                r1: { __typename: 'Issue', issueState: 'OPEN' },
                r2: null,
            };
        });
        const answers = await c.fetch(urls, signal);
        expect(asked[0]).toMatchObject({
            u0: 'https://github.com/o/r/pull/1',
            u1: 'https://github.com/o/r/issues/2',
            headers: { authorization: 'bearer tok' },
            request: { signal },
        });
        expect([...answers.values()]).toEqual([
            { label: 'merged', category: 'done', lines: ['o/r#1'] },
            { label: 'open', category: 'open', lines: ['o/r#2'] },
            { error: 'o/r#3 not found, or no access to it' },
        ]);
    });

    it('answers what came back when some links failed', async () => {
        const c = connector(async () => {
            throw new GraphqlResponseError({ method: 'POST', url: '/graphql' } as never, {}, {
                data: { r0: { __typename: 'Issue', issueState: 'OPEN' }, r1: null, r2: null },
                errors: [
                    {
                        path: ['r1'],
                        message: "Could not resolve to a node with the global id of 'x'",
                        type: 'NOT_FOUND',
                    },
                ],
            } as never);
        });
        const answers = [...(await c.fetch(urls, signal)).values()];
        expect(answers[0]).toMatchObject({ label: 'open' });
        expect(answers[1]).toEqual({
            error: "Could not resolve to a node with the global id of 'x'",
        });
        expect(answers[2]).toEqual({ error: 'o/r#3 not found, or no access to it' });
    });

    it('waits when GitHub says so, and fails the batch on anything else', async () => {
        const limited = connector(async () => {
            throw Object.assign(new Error('API rate limit exceeded'), {
                status: 403,
                response: { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '60' } },
            });
        });
        await expect(limited.fetch(urls, signal)).rejects.toEqual(
            new RateLimited(60_000, 'GitHub rate limit'),
        );
        await expect(
            connector(async () => Promise.reject(new Error('socket hang up'))).fetch(urls, signal),
        ).rejects.toThrow('socket hang up');
    });

    it('says so for each link with no session, and asks GitHub nothing', async () => {
        let asked = false;
        const c = connector(async () => {
            asked = true;
            return {};
        }, '');
        expect([...(await c.fetch(urls, signal)).values()]).toEqual(
            urls.map(() => ({ error: NOT_SIGNED_IN })),
        );
        expect(asked).toBe(false);
        expect(c.matches('https://github.com/o/r/pull/1')).toBe(true);
        expect(c.matches('https://example.com/o/r/pull/1')).toBe(false);
    });
});
