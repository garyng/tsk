import { GraphqlResponseError, graphql as octokitGraphql } from '@octokit/graphql';
import { type Answer, type Connector, RateLimited } from './queue';
import type { Checks, LinkStatus } from './status';

/**
 * The GitHub connector: a PR's state and its CI checks, an issue's state, for up to
 * 50 links in one GraphQL query, each through `resource(url:)`. The token is
 * the editor's GitHub session; the editor layer passes it in.
 */

/** A GitHub PR or issue link: the item's own URL (anything after its number dropped), and `owner/repo#n`. */
export function githubItem(url: string): { url: string; ref: string } | undefined {
    const m =
        /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)(?:[/?#].*)?$/.exec(url);
    if (!m) return undefined;
    const [, owner, repo, kind, n] = m;
    return {
        url: `https://github.com/${owner}/${repo}/${kind}/${n}`,
        ref: `${owner}/${repo}#${n}`,
    };
}

// `state` is a PullRequestState on one and an IssueState on the other: GraphQL refuses the same
// field name with two types in one selection, so each gets its own (checked against the schema).
const FIELDS = `__typename
    ... on PullRequest {
      title
      prState: state
      isDraft
      reviewDecision
      author { login }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
    ... on Issue { title issueState: state stateReason author { login } }`;

/** The query for `n` links, each `r<i>: resource(url: $u<i>)`: the URLs go in as variables, never into the text. */
export function itemsQuery(n: number): string {
    const ids = Array.from({ length: n }, (_, i) => i);
    const vars = ids.map((i) => `$u${i}: URI!`).join(', ');
    const items = ids.map((i) => `  r${i}: resource(url: $u${i}) {\n    ${FIELDS}\n  }`).join('\n');
    return `query(${vars}) {\n${items}\n}`;
}

interface Node {
    readonly __typename?: string;
    readonly title?: string;
    readonly prState?: string;
    readonly issueState?: string;
    readonly isDraft?: boolean;
    readonly reviewDecision?: string | null;
    readonly stateReason?: string | null;
    readonly author?: { readonly login?: string } | null;
    readonly commits?: {
        readonly nodes?: readonly ({
            readonly commit?: { readonly statusCheckRollup?: { readonly state?: string } | null };
        } | null)[];
    };
}

const CHECKS: Readonly<Record<string, Checks>> = {
    SUCCESS: 'passing',
    FAILURE: 'failing',
    ERROR: 'failing',
    PENDING: 'pending',
    EXPECTED: 'pending',
};
const REVIEW: Readonly<Record<string, string>> = {
    APPROVED: 'approved',
    CHANGES_REQUESTED: 'changes requested',
    REVIEW_REQUIRED: 'review required',
};

/** A PR's or issue's status, from what `resource` gave for it. */
export function statusOf(node: Node | null | undefined, ref: string): Answer {
    if (!node) return { error: `${ref} not found, or no access to it` };
    const by = node.author?.login ? ` · @${node.author.login}` : '';
    const title = node.title ? { title: node.title } : {};
    if (node.__typename === 'PullRequest') {
        const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
        const checks = rollup ? CHECKS[rollup] : undefined;
        const review = node.reviewDecision ? REVIEW[node.reviewDecision] : undefined;
        const lines = [`${ref}${by}`, ...(review && node.prState === 'OPEN' ? [review] : [])];
        const state: Pick<LinkStatus, 'label' | 'category'> =
            node.prState === 'MERGED'
                ? { label: 'merged', category: 'done' }
                : node.prState === 'CLOSED'
                  ? { label: 'closed', category: 'closed' }
                  : { label: node.isDraft ? 'draft' : 'open', category: 'open' };
        return { ...state, ...title, ...(checks ? { checks } : {}), lines };
    }
    if (node.__typename === 'Issue') {
        const lines = [`${ref}${by}`];
        if (node.issueState === 'OPEN') return { label: 'open', category: 'open', ...title, lines };
        // Completed is done; not planned (and a duplicate) closed without being done.
        const done = node.stateReason === 'COMPLETED' || !node.stateReason;
        return { label: 'closed', category: done ? 'done' : 'closed', ...title, lines };
    }
    return { error: `${ref} is a ${node.__typename ?? 'thing'}, not a PR or an issue` };
}

/** What the hover says when there's no session: the editor layer offers to sign in. */
export const NOT_SIGNED_IN = 'not signed in to GitHub';

export interface GitHubIo {
    /** The editor's GitHub session token, or undefined when there's none. */
    readonly token: () => Promise<string | undefined>;
    /** Runs the query; tests stand one in. */
    readonly graphql?: typeof octokitGraphql;
    readonly now?: () => number;
}

/** GitHub asked us to wait, until when (epoch ms), from its headers: undefined when it didn't. */
export function waitUntil(
    headers: Readonly<Record<string, unknown>> | undefined,
    now: number,
): number | undefined {
    const retryAfter = Number(headers?.['retry-after']);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1000;
    const reset = Number(headers?.['x-ratelimit-reset']);
    if (headers?.['x-ratelimit-remaining'] === '0' && Number.isFinite(reset)) return reset * 1000;
    return undefined;
}

export function githubConnector(io: GitHubIo): Connector {
    const now = io.now ?? Date.now;
    return {
        name: 'github',
        batchSize: 50,
        matches: (url) => githubItem(url) !== undefined,
        async fetch(urls, signal) {
            const token = await io.token();
            if (!token) return new Map(urls.map((u) => [u, { error: NOT_SIGNED_IN }]));
            const items = urls.map((u) => githubItem(u) ?? { url: u, ref: u });
            const variables = Object.fromEntries(items.map((it, i) => [`u${i}`, it.url]));
            let data: Record<string, Node | null> = {};
            let errors: readonly {
                path?: readonly (string | number)[];
                message: string;
                type?: string;
            }[] = [];
            try {
                data = await (io.graphql ?? octokitGraphql)<Record<string, Node | null>>(
                    itemsQuery(items.length),
                    {
                        ...variables,
                        headers: { authorization: `bearer ${token}` },
                        request: { signal },
                    },
                );
            } catch (e) {
                const headers =
                    (
                        e as {
                            headers?: Record<string, unknown>;
                            response?: { headers?: Record<string, unknown> };
                        }
                    ).headers ??
                    (e as { response?: { headers?: Record<string, unknown> } }).response?.headers;
                const until = waitUntil(headers, now());
                if (e instanceof GraphqlResponseError) {
                    if (e.errors?.some((x) => (x as { type?: string }).type === 'RATE_LIMITED'))
                        throw new RateLimited(until ?? now() + 60_000, 'GitHub rate limit');
                    // Some items failed (no access, gone): the rest came back.
                    data = (e.data as Record<string, Node | null> | undefined) ?? {};
                    errors = (e.errors ?? []) as typeof errors;
                } else {
                    const status = (e as { status?: number }).status;
                    if ((status === 403 || status === 429) && until !== undefined)
                        throw new RateLimited(until, 'GitHub rate limit');
                    if (status === 401)
                        return new Map(
                            urls.map((u) => [u, { error: 'GitHub refused the session token' }]),
                        );
                    throw e;
                }
            }
            return new Map(
                items.map((it, i) => {
                    const failed = errors.find((x) => x.path?.[0] === `r${i}`);
                    const url = urls[i] as string;
                    return [
                        url,
                        failed && !data[`r${i}`]
                            ? { error: failed.message }
                            : statusOf(data[`r${i}`], it.ref),
                    ];
                }),
            );
        },
    };
}
