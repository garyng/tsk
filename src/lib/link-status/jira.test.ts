import { describe, expect, it } from 'vitest';
import { jiraConnector, jiraKey, NO_TOKEN, REFUSED, statusOf } from './jira';
import { RateLimited } from './queue';

const SITE = 'https://acme.atlassian.net';
const GATEWAY = 'https://api.atlassian.com/ex/jira/cloud-1';

describe('jiraKey', () => {
    it("takes an issue link on the site, by /browse/ or a board's selectedIssue", () => {
        expect(jiraKey(`${SITE}/browse/ABC-12`, SITE)).toBe('ABC-12');
        expect(jiraKey(`${SITE}/browse/abc-12?focusedCommentId=1`, SITE)).toBe('ABC-12');
        expect(
            jiraKey(`${SITE}/jira/software/projects/ABC/boards/1?selectedIssue=ABC-7`, SITE),
        ).toBe('ABC-7');
        expect(jiraKey('https://other.atlassian.net/browse/ABC-12', SITE)).toBeUndefined();
        expect(jiraKey(`${SITE}/jira/projects`, SITE)).toBeUndefined();
    });
});

describe('statusOf', () => {
    it("names the status, coloured by Jira's status category", () => {
        const issue = (key: string, assignee?: string) => ({
            key: 'ABC-1',
            fields: {
                summary: 'Fix login',
                status: { name: 'In Review', statusCategory: { key } },
                assignee: assignee ? { displayName: assignee } : null,
            },
        });
        expect(statusOf(issue('indeterminate', 'Ada Lovelace'), 'ABC-1')).toEqual({
            label: 'In Review',
            category: 'inProgress',
            title: 'Fix login',
            lines: ['ABC-1 · Ada Lovelace'],
        });
        expect(statusOf(issue('new'), 'ABC-1')).toMatchObject({
            category: 'open',
            lines: ['ABC-1 · unassigned'],
        });
        expect(statusOf(issue('done'), 'ABC-1')).toMatchObject({ category: 'done' });
        expect(statusOf(issue('weird'), 'ABC-1')).toMatchObject({ category: 'unknown' });
        expect(statusOf(undefined, 'ABC-9')).toEqual({
            error: 'ABC-9 not found, or no access to it',
        });
    });
});

describe('jiraConnector', () => {
    const signal = new AbortController().signal;
    const json = (body: unknown, init: ResponseInit = {}) =>
        new Response(JSON.stringify(body), {
            headers: { 'content-type': 'application/json' },
            ...init,
        });
    /** The site refuses as anonymous, the way Jira Cloud does: 200, no issues, and the header. */
    const anonymous = () =>
        json(
            { issues: [], issueErrors: [] },
            { headers: { 'x-seraph-loginreason': 'AUTHENTICATED_FAILED' } },
        );
    const found = (...keys: string[]) =>
        json({
            issues: keys.map((key) => ({
                key,
                fields: { status: { name: 'Done', statusCategory: { key: 'done' } } },
            })),
            issueErrors: [],
        });

    /** A connector over a stand-in fetch answering by URL; it records each request. */
    function connector(answer: (url: string) => Response, token = 'tok') {
        const asked: { url: string; init?: RequestInit }[] = [];
        const http = (async (url: string, init?: RequestInit) => {
            asked.push({ url, init });
            return answer(url);
        }) as typeof fetch;
        const c = jiraConnector(
            { site: SITE, email: 'me@acme.com' },
            { token: async () => token || undefined, fetch: http, now: () => 0 },
        );
        return { c, asked };
    }

    it('asks for every key once, with Basic auth, and answers each link by its key', async () => {
        const { c, asked } = connector(() => found('ABC-1'));
        const urls = [`${SITE}/browse/ABC-1`, `${SITE}/browse/abc-1#x`, `${SITE}/browse/ABC-2`];
        const answers = [...(await c.fetch(urls, signal)).values()];
        expect(asked).toHaveLength(1);
        expect(asked[0]?.url).toBe(`${SITE}/rest/api/3/issue/bulkfetch`);
        const init = asked[0]?.init as RequestInit & { headers: Record<string, string> };
        expect(init.headers.authorization).toBe(
            `Basic ${Buffer.from('me@acme.com:tok').toString('base64')}`,
        );
        expect(JSON.parse(init.body as string)).toEqual({
            issueIdsOrKeys: ['ABC-1', 'ABC-2'],
            fields: ['summary', 'status', 'assignee'],
        });
        expect(answers.map((a) => ('error' in a ? a.error : a.label))).toEqual([
            'Done',
            'Done',
            'ABC-2 not found, or no access to it',
        ]);
    });

    it('moves to the gateway when the site answers as anonymous, and stays there', async () => {
        const { c, asked } = connector((url) =>
            url === `${SITE}/_edge/tenant_info`
                ? json({ cloudId: 'cloud-1' })
                : url.startsWith(GATEWAY)
                  ? found('ABC-1')
                  : anonymous(),
        );
        const first = await c.fetch([`${SITE}/browse/ABC-1`], signal);
        expect([...first.values()][0]).toMatchObject({ label: 'Done' });
        await c.fetch([`${SITE}/browse/ABC-1`], signal);
        expect(asked.map((a) => a.url)).toEqual([
            `${SITE}/rest/api/3/issue/bulkfetch`,
            `${SITE}/_edge/tenant_info`,
            `${GATEWAY}/rest/api/3/issue/bulkfetch`,
            `${GATEWAY}/rest/api/3/issue/bulkfetch`,
        ]);
    });

    it('says the token was refused when neither takes it, and that there is none', async () => {
        const refusing = connector((url) =>
            url.endsWith('tenant_info')
                ? json({ cloudId: 'cloud-1' })
                : url.startsWith(GATEWAY)
                  ? new Response('', { status: 401 })
                  : anonymous(),
        );
        expect([...(await refusing.c.fetch([`${SITE}/browse/ABC-1`], signal)).values()]).toEqual([
            { error: REFUSED },
        ]);
        const none = connector(() => found(), '');
        expect([...(await none.c.fetch([`${SITE}/browse/ABC-1`], signal)).values()]).toEqual([
            { error: NO_TOKEN },
        ]);
        expect(none.asked).toEqual([]);
    });

    it("waits when Jira says so, and fails the batch on Jira's other errors", async () => {
        const limited = connector(
            () => new Response('', { status: 429, headers: { 'retry-after': '30' } }),
        );
        await expect(limited.c.fetch([`${SITE}/browse/ABC-1`], signal)).rejects.toEqual(
            new RateLimited(30_000, 'Jira: HTTP 429'),
        );
        const broken = connector(() => new Response('oops', { status: 500 }));
        await expect(broken.c.fetch([`${SITE}/browse/ABC-1`], signal)).rejects.toThrow(
            'Jira: HTTP 500 oops',
        );
    });
});
