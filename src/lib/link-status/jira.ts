import { type Answer, type Connector, RateLimited } from './queue';
import type { Category } from './status';

/**
 * The Jira Cloud connector: each issue's status by its key, up to 100 in one
 * `POST /rest/api/3/issue/bulkfetch`. Plain `fetch`: `jira.js` is 20 MB
 * unpacked for this one call.
 *
 * Jira Cloud takes an API token with the account's email, as Basic auth (it
 * has no personal access tokens; those are Server / Data Center's). A token
 * without scopes is called at the site; one with scopes only through
 * `https://api.atlassian.com/ex/jira/<cloudId>`, the site's cloud id read from
 * `<site>/_edge/tenant_info`. The site is tried first; refused there, it moves to
 * the gateway, and the connector keeps to whichever answered.
 *
 * Refused, at the site, isn't a 401: bulkfetch answers credentials it rejects as
 * an anonymous user, 200 with no issues, and only `x-seraph-loginreason:
 * AUTHENTICATED_FAILED` says so (checked against a site, 2026-11-08).
 */

/** Jira didn't take the credentials, by status or by the header it answers anonymously with. */
const refused = (res: Response) =>
    res.status === 401 ||
    /AUTHENTICATED_FAILED/i.test(res.headers.get('x-seraph-loginreason') ?? '');

export interface JiraSite {
    /** `https://<site>.atlassian.net`, no trailing slash. */
    readonly site: string;
    readonly email: string;
}

/** A link to an issue on `site`: its key, from `/browse/KEY` or a board's `?selectedIssue=KEY`. */
export function jiraKey(url: string, site: string): string | undefined {
    if (!url.startsWith(`${site}/`)) return undefined;
    const key =
        /\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:[/?#]|$)/i.exec(url)?.[1] ??
        /[?&]selectedIssue=([A-Z][A-Z0-9_]*-\d+)(?:&|#|$)/i.exec(url)?.[1];
    return key?.toUpperCase();
}

interface Issue {
    readonly key?: string;
    readonly fields?: {
        readonly summary?: string;
        readonly status?: {
            readonly name?: string;
            readonly statusCategory?: { readonly key?: string };
        };
        readonly assignee?: { readonly displayName?: string } | null;
    };
}

const CATEGORY: Readonly<Record<string, Category>> = {
    new: 'open',
    indeterminate: 'inProgress',
    done: 'done',
};

/** An issue's status: its status's name, coloured by Jira's own status category. */
export function statusOf(issue: Issue | undefined, key: string): Answer {
    const status = issue?.fields?.status;
    if (!status?.name) return { error: `${key} not found, or no access to it` };
    const who = issue?.fields?.assignee?.displayName;
    return {
        label: status.name,
        category: CATEGORY[status.statusCategory?.key ?? ''] ?? 'unknown',
        ...(issue?.fields?.summary ? { title: issue.fields.summary } : {}),
        lines: [who ? `${key} · ${who}` : `${key} · unassigned`],
    };
}

/** What the hover says with no token: the editor layer offers to set one. */
export const NO_TOKEN = 'no Jira API token';
export const REFUSED = 'Jira refused the API token';

export interface JiraIo {
    /** The API token from secret storage, or undefined when there's none. */
    readonly token: () => Promise<string | undefined>;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
}

export function jiraConnector({ site, email }: JiraSite, io: JiraIo): Connector {
    const http = io.fetch ?? fetch;
    const now = io.now ?? Date.now;
    /** Where the last request was answered: the site, or the gateway for a scoped token. */
    let base = site;
    const post = (at: string, token: string, keys: readonly string[], signal: AbortSignal) =>
        http(`${at}/rest/api/3/issue/bulkfetch`, {
            method: 'POST',
            headers: {
                authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
                accept: 'application/json',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                issueIdsOrKeys: keys,
                fields: ['summary', 'status', 'assignee'],
            }),
            signal,
        });
    const gateway = async (signal: AbortSignal) => {
        const res = await http(`${site}/_edge/tenant_info`, { signal });
        const cloudId = res.ok ? ((await res.json()) as { cloudId?: string }).cloudId : undefined;
        return cloudId ? `https://api.atlassian.com/ex/jira/${cloudId}` : undefined;
    };
    return {
        name: 'jira',
        batchSize: 100,
        matches: (url) => jiraKey(url, site) !== undefined,
        async fetch(urls, signal) {
            const token = await io.token();
            if (!token) return new Map(urls.map((u) => [u, { error: NO_TOKEN }]));
            const keyOf = new Map(urls.map((u) => [u, jiraKey(u, site) ?? u]));
            const keys = [...new Set(keyOf.values())];
            let res = await post(base, token, keys, signal);
            if (refused(res) && base === site) {
                // A token with scopes is refused at the site, and taken at the gateway.
                const other = await gateway(signal);
                if (other) {
                    const retry = await post(other, token, keys, signal);
                    if (!refused(retry)) {
                        base = other;
                        res = retry;
                    }
                }
            }
            if (refused(res)) return new Map(urls.map((u) => [u, { error: REFUSED }]));
            if (res.status === 429 || res.status === 503) {
                const after = Number(res.headers.get('retry-after'));
                throw new RateLimited(
                    now() + (Number.isFinite(after) && after > 0 ? after : 60) * 1000,
                    `Jira: HTTP ${res.status}`,
                );
            }
            if (!res.ok)
                throw new Error(`Jira: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
            const body = (await res.json()) as {
                issues?: Issue[];
                issueErrors?: { errorMessage?: string }[];
            };
            const byKey = new Map((body.issues ?? []).map((i) => [i.key?.toUpperCase(), i]));
            // Jira leaves out an issue it can't find or show; an error it lists names an issue id.
            const failed = body.issueErrors?.[0]?.errorMessage;
            return new Map(
                urls.map((u) => {
                    const key = keyOf.get(u) as string;
                    const issue = byKey.get(key);
                    return [
                        u,
                        !issue && failed ? { error: `Jira: ${failed}` } : statusOf(issue, key),
                    ];
                }),
            );
        },
    };
}
