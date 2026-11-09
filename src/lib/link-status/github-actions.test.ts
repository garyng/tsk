import { describe, expect, it } from 'vitest';
import { NOT_SIGNED_IN, TOKEN_REFUSED } from './github';
import { githubActionsConnector, githubRun, runStatusOf } from './github-actions';
import { RateLimited } from './queue';

const REPO = 'https://github.com/o/r-1.x';

describe('githubRun', () => {
    it("takes a run's, an attempt's or a job's link, whatever follows", () => {
        expect(githubRun(`${REPO}/actions/runs/42?pr=7`)).toEqual({
            kind: 'run',
            path: '/repos/o/r-1.x/actions/runs/42',
            ref: 'o/r-1.x run 42',
        });
        expect(githubRun(`${REPO}/actions/runs/42/attempts/2`)).toEqual({
            kind: 'run',
            path: '/repos/o/r-1.x/actions/runs/42/attempts/2',
            ref: 'o/r-1.x run 42 attempt 2',
        });
        expect(githubRun(`${REPO}/actions/runs/42/job/99#step:3:1`)).toEqual({
            kind: 'job',
            path: '/repos/o/r-1.x/actions/jobs/99',
            ref: 'o/r-1.x job 99',
        });
        for (const other of [
            `${REPO}/actions`,
            `${REPO}/actions/runs/42abc`,
            `${REPO}/actions/workflows/ci.yml`,
            `${REPO}/pull/1`,
            'https://gitlab.com/o/r/actions/runs/1',
        ])
            expect(githubRun(other)).toBeUndefined();
    });
});

describe('runStatusOf', () => {
    // As GitHub answered for a run of actions/checkout (2026-11-09), trimmed.
    const run = {
        name: 'CodeQL',
        display_title: 'Restore full history',
        status: 'completed',
        conclusion: 'success',
        run_number: 1482,
        run_attempt: 1,
        head_branch: 'main',
        actor: { login: 'octocat' },
    };

    it("names the run's conclusion once it finishes, its status until then", () => {
        expect(runStatusOf(run, 'run', 'o/r run 1')).toEqual({
            label: 'success',
            category: 'done',
            checks: 'passing',
            title: 'Restore full history',
            lines: ['CodeQL #1482 · main · @octocat'],
        });
        expect(
            runStatusOf({ ...run, status: 'in_progress', conclusion: null }, 'run', 'x'),
        ).toMatchObject({ label: 'in progress', category: 'inProgress', checks: 'pending' });
        expect(
            runStatusOf({ ...run, conclusion: 'timed_out', run_attempt: 2 }, 'run', 'x'),
        ).toMatchObject({
            label: 'timed out',
            category: 'failed',
            checks: 'failing',
            lines: ['CodeQL #1482 · attempt 2 · main · @octocat'],
        });
        expect(runStatusOf({ ...run, conclusion: 'cancelled' }, 'run', 'x')).toEqual(
            expect.objectContaining({ category: 'closed' }),
        );
        expect(runStatusOf({ ...run, conclusion: 'cancelled' }, 'run', 'x')).not.toHaveProperty(
            'checks',
        );
        expect(runStatusOf({ ...run, conclusion: 'action_required' }, 'run', 'x')).toMatchObject({
            label: 'action required',
            category: 'inProgress',
        });
        expect(runStatusOf({ ...run, conclusion: 'new_one' }, 'run', 'x')).toMatchObject({
            category: 'unknown',
        });
        expect(runStatusOf({}, 'run', 'o/r run 1')).toEqual({
            error: 'o/r run 1: GitHub gave no status',
        });
    });

    it('names a job, its workflow and branch, and the step that failed', () => {
        expect(
            runStatusOf(
                {
                    name: 'Analyze (javascript)',
                    workflow_name: 'CodeQL',
                    head_branch: 'main',
                    status: 'completed',
                    conclusion: 'failure',
                    steps: [
                        { name: 'Set up job', conclusion: 'success' },
                        { name: 'Run npm ci', conclusion: 'failure' },
                        { name: 'Complete job', conclusion: 'skipped' },
                    ],
                },
                'job',
                'o/r job 9',
            ),
        ).toEqual({
            label: 'failure',
            category: 'failed',
            checks: 'failing',
            title: 'Analyze (javascript)',
            lines: ['CodeQL · main', 'failed step: Run npm ci'],
        });
        expect(runStatusOf({ status: 'queued' }, 'job', 'o/r job 9')).toMatchObject({
            label: 'queued',
            lines: ['o/r job 9'],
        });
    });
});

describe('githubActionsConnector', () => {
    const signal = new AbortController().signal;
    const json = (body: unknown, init: ResponseInit = {}) =>
        new Response(JSON.stringify(body), {
            ...init,
            headers: { 'content-type': 'application/json', ...init.headers },
        });

    /** A connector over a stand-in fetch answering by URL; it records each request. */
    function connector(answer: (url: string) => Response, token = 'tok') {
        const asked: { url: string; init?: RequestInit }[] = [];
        const http = (async (url: string, init?: RequestInit) => {
            asked.push({ url, init });
            return answer(url);
        }) as typeof fetch;
        const c = githubActionsConnector({
            token: async () => token || undefined,
            fetch: http,
            now: () => 0,
        });
        return { c, asked };
    }

    it('asks the REST API for each link, with the session token', async () => {
        const { c, asked } = connector((url) =>
            url.endsWith('/jobs/9')
                ? json({ name: 'build', status: 'in_progress' })
                : json({ name: 'CI', status: 'completed', conclusion: 'success' }),
        );
        const urls = [`${REPO}/actions/runs/1`, `${REPO}/actions/runs/1/job/9`];
        const answers = await c.fetch(urls, signal);
        expect(asked.map((a) => a.url)).toEqual([
            'https://api.github.com/repos/o/r-1.x/actions/runs/1',
            'https://api.github.com/repos/o/r-1.x/actions/jobs/9',
        ]);
        const headers = asked[0]?.init?.headers as Record<string, string>;
        expect(headers.authorization).toBe('Bearer tok');
        expect(urls.map((u) => answers.get(u))).toMatchObject([
            { label: 'success' },
            { label: 'in progress' },
        ]);
    });

    it("answers each link's refusal as its own, and asks nothing without a session", async () => {
        const { c } = connector((url) =>
            url.endsWith('/runs/1')
                ? json({ message: 'Not Found' }, { status: 404 })
                : url.endsWith('/runs/2')
                  ? json({ message: 'Resource protected by SAML enforcement' }, { status: 403 })
                  : json({ message: 'Bad credentials' }, { status: 401 }),
        );
        const urls = [1, 2, 3].map((n) => `${REPO}/actions/runs/${n}`);
        expect([...(await c.fetch(urls, signal)).values()]).toEqual([
            { error: 'o/r-1.x run 1 not found, or no access to it' },
            { error: 'GitHub: Resource protected by SAML enforcement (o/r-1.x run 2)' },
            { error: TOKEN_REFUSED },
        ]);
        const none = connector(() => json({}), '');
        expect([...(await none.c.fetch(urls, signal)).values()]).toEqual(
            urls.map(() => ({ error: NOT_SIGNED_IN })),
        );
        expect(none.asked).toEqual([]);
    });

    it('waits when GitHub says so, and fails the batch when GitHub fails', async () => {
        const limited = connector(() =>
            json(
                { message: 'API rate limit exceeded' },
                {
                    status: 403,
                    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000' },
                },
            ),
        );
        await expect(limited.c.fetch([`${REPO}/actions/runs/1`], signal)).rejects.toEqual(
            new RateLimited(2_000_000, 'GitHub: HTTP 403'),
        );
        const tooMany = connector(() => new Response('', { status: 429 }));
        await expect(tooMany.c.fetch([`${REPO}/actions/runs/1`], signal)).rejects.toEqual(
            new RateLimited(60_000, 'GitHub: HTTP 429'),
        );
        const broken = connector(() => new Response('oops', { status: 502 }));
        await expect(broken.c.fetch([`${REPO}/actions/runs/1`], signal)).rejects.toThrow(
            'GitHub: HTTP 502 for o/r-1.x run 1 oops',
        );
    });
});
