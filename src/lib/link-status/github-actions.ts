import { NOT_SIGNED_IN, TOKEN_REFUSED, waitUntil } from './github';
import { type Answer, type Connector, RateLimited } from './queue';
import type { LinkStatus } from './status';

/**
 * The GitHub Actions connector: a workflow run's state, an attempt's or a job's,
 * through the REST API, a request per link. Not GraphQL, as PRs and issues are:
 * its `WorkflowRun` has no status of its own (its check suite has) and no
 * display title. The token is the editor's GitHub session, as for PRs.
 */

/** A link to a run, one attempt of it or one of its jobs: what it is, the REST path that answers it, and a name for it. */
export function githubRun(
    url: string,
): { kind: 'run' | 'job'; path: string; ref: string } | undefined {
    const m =
        /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)(?:\/attempts\/(\d+)|\/job\/(\d+))?(?:[/?#].*)?$/.exec(
            url,
        );
    if (!m) return undefined;
    const [, owner, repo, run, attempt, job] = m;
    const at = `/repos/${owner}/${repo}/actions`;
    if (job) return { kind: 'job', path: `${at}/jobs/${job}`, ref: `${owner}/${repo} job ${job}` };
    if (attempt)
        return {
            kind: 'run',
            path: `${at}/runs/${run}/attempts/${attempt}`,
            ref: `${owner}/${repo} run ${run} attempt ${attempt}`,
        };
    return { kind: 'run', path: `${at}/runs/${run}`, ref: `${owner}/${repo} run ${run}` };
}

/** A run (or an attempt of it) or a job, as the REST API answers it: what the status needs. */
export interface Run {
    readonly status?: string;
    readonly conclusion?: string | null;
    /** A run's workflow; a job's own name. */
    readonly name?: string;
    readonly display_title?: string;
    readonly workflow_name?: string;
    readonly run_number?: number;
    readonly run_attempt?: number;
    readonly head_branch?: string | null;
    readonly actor?: { readonly login?: string } | null;
    readonly steps?: readonly { readonly name?: string; readonly conclusion?: string | null }[];
}

const FAILED = { category: 'failed', checks: 'failing' } as const;
const CLOSED = { category: 'closed' } as const;
/** A finished run's conclusion, as a category and checks. */
const BY_CONCLUSION: Readonly<Record<string, Pick<LinkStatus, 'category' | 'checks'>>> = {
    success: { category: 'done', checks: 'passing' },
    neutral: { category: 'done' },
    failure: FAILED,
    timed_out: FAILED,
    startup_failure: FAILED,
    cancelled: CLOSED,
    skipped: CLOSED,
    stale: CLOSED,
    // Waiting on someone to approve it: it hasn't run yet.
    action_required: { category: 'inProgress', checks: 'pending' },
};

const joined = (...parts: (string | false | undefined | null)[]) =>
    parts.filter(Boolean).join(' · ');

/** A run's or a job's status: GitHub's own word for it, its status until it finishes and its conclusion after. */
export function runStatusOf(run: Run, kind: 'run' | 'job', ref: string): Answer {
    const word = run.status === 'completed' ? run.conclusion : run.status;
    if (!word) return { error: `${ref}: GitHub gave no status` };
    const state =
        run.status === 'completed'
            ? (BY_CONCLUSION[word] ?? { category: 'unknown' })
            : ({ category: 'inProgress', checks: 'pending' } as const);
    const branch = run.head_branch ?? undefined;
    if (kind === 'job') {
        const failedStep = run.steps?.find((s) => s.conclusion === 'failure')?.name;
        return {
            label: word.replace(/_/g, ' '),
            ...state,
            ...(run.name ? { title: run.name } : {}),
            lines: [
                joined(run.workflow_name, branch) || ref,
                ...(failedStep ? [`failed step: ${failedStep}`] : []),
            ],
        };
    }
    const attempt = (run.run_attempt ?? 1) > 1 && `attempt ${run.run_attempt}`;
    const actor = run.actor?.login && `@${run.actor.login}`;
    const workflow = run.name && (run.run_number ? `${run.name} #${run.run_number}` : run.name);
    return {
        label: word.replace(/_/g, ' '),
        ...state,
        ...(run.display_title ? { title: run.display_title } : {}),
        lines: [joined(workflow, attempt, branch, actor) || ref],
    };
}

export interface GitHubActionsIo {
    /** The editor's GitHub session token, or undefined when there's none. */
    readonly token: () => Promise<string | undefined>;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
}

export function githubActionsConnector(io: GitHubActionsIo): Connector {
    const http = io.fetch ?? fetch;
    const now = io.now ?? Date.now;
    /** One link's answer; throws for the queue on a rate limit or GitHub failing. */
    async function one(url: string, token: string, signal: AbortSignal): Promise<Answer> {
        const link = githubRun(url);
        if (!link) return { error: `${url} is not a GitHub Actions run or job` };
        const res = await http(`https://api.github.com${link.path}`, {
            headers: {
                authorization: `Bearer ${token}`,
                accept: 'application/vnd.github+json',
                'x-github-api-version': '2022-11-28',
            },
            signal,
        });
        if (res.ok) return runStatusOf((await res.json()) as Run, link.kind, link.ref);
        const until = waitUntil(Object.fromEntries(res.headers), now());
        if (res.status === 429 || (res.status === 403 && until !== undefined))
            throw new RateLimited(until ?? now() + 60_000, `GitHub: HTTP ${res.status}`);
        if (res.status === 401) return { error: TOKEN_REFUSED };
        if (res.status === 404) return { error: `${link.ref} not found, or no access to it` };
        const text = (await res.text()).slice(0, 200);
        let message = text;
        try {
            message = (JSON.parse(text) as { message?: string }).message ?? text;
        } catch {
            // Not JSON: its text is the message.
        }
        // One repo's refusal (an organisation's SSO, say) is that link's; GitHub failing is the batch's.
        if (res.status < 500) return { error: `GitHub: ${message} (${link.ref})` };
        throw new Error(`GitHub: HTTP ${res.status} for ${link.ref} ${message}`);
    }

    return {
        name: 'github-actions',
        // A request per link, in parallel: 10 a batch, two batches at once, is 20 in flight,
        // well under the 100 GitHub allows.
        batchSize: 10,
        matches: (url) => githubRun(url) !== undefined,
        async fetch(urls, signal) {
            const token = await io.token();
            if (!token) return new Map(urls.map((u) => [u, { error: NOT_SIGNED_IN }]));
            const answers = await Promise.all(urls.map((u) => one(u, token, signal)));
            return new Map(urls.map((u, i) => [u, answers[i] as Answer]));
        },
    };
}
