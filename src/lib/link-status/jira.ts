import { type Answer, type Connector, RateLimited } from './queue';
import type { Category } from './status';

/**
 * The Jira Cloud connector: each issue's status by its key, up to 100 in one
 * `POST /rest/api/3/issue/bulkfetch` per site. Plain `fetch`: `jira.js` is
 * 20 MB unpacked for this one call.
 *
 * Any Atlassian Cloud site the links point to, pasted or an autolink's target,
 * with an email and a token per site: a site with none is never asked.
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

/** A link to an Atlassian Cloud issue: its site (the origin) and key, from `/browse/KEY` or a board's `?selectedIssue=KEY`. */
export function jiraIssue(url: string): { site: string; key: string } | undefined {
    const site = /^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net(?=[/?#]|$)/i.exec(url)?.[0];
    if (!site) return undefined;
    const key =
        /\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:[/?#]|$)/i.exec(url)?.[1] ??
        /[?&]selectedIssue=([A-Z][A-Z0-9_]*-\d+)(?:&|#|$)/i.exec(url)?.[1];
    return key ? { site: site.toLowerCase(), key: key.toUpperCase() } : undefined;
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

/** The start of what the hover says with no token, or a refused one: the editor layer offers to set one. */
export const NO_TOKEN = 'no Jira API token';
export const REFUSED = 'Jira refused the API token';

export interface JiraCredentials {
    readonly email: string;
    readonly token: string;
}

export interface JiraIo {
    /** A site's email and API token, from secret storage; undefined when there are none. */
    readonly credentials: (site: string) => Promise<JiraCredentials | undefined>;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
}

export function jiraConnector(io: JiraIo): Connector {
    const http = io.fetch ?? fetch;
    const now = io.now ?? Date.now;
    /** Where each site's last request was answered: the site, or the gateway for a scoped token. */
    const bases = new Map<string, string>();
    const post = (
        at: string,
        { email, token }: JiraCredentials,
        keys: readonly string[],
        signal: AbortSignal,
    ) =>
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
    const gateway = async (site: string, signal: AbortSignal) => {
        const res = await http(`${site}/_edge/tenant_info`, { signal });
        const cloudId = res.ok ? ((await res.json()) as { cloudId?: string }).cloudId : undefined;
        return cloudId ? `https://api.atlassian.com/ex/jira/${cloudId}` : undefined;
    };
    /** One site's links: their answers, or a throw for the queue (a rate limit, a failure). */
    async function fromSite(
        site: string,
        links: readonly { url: string; key: string }[],
        signal: AbortSignal,
    ) {
        const host = new URL(site).host;
        const all = (answer: Answer) => links.map(({ url }) => [url, answer] as const);
        const creds = await io.credentials(site);
        if (!creds) return all({ error: `${NO_TOKEN} for ${host}` });
        const keys = [...new Set(links.map((l) => l.key))];
        const base = bases.get(site) ?? site;
        let res = await post(base, creds, keys, signal);
        if (refused(res) && base === site) {
            // A token with scopes is refused at the site, and taken at the gateway.
            const other = await gateway(site, signal);
            if (other) {
                const retry = await post(other, creds, keys, signal);
                if (!refused(retry)) {
                    bases.set(site, other);
                    res = retry;
                }
            }
        }
        if (refused(res)) return all({ error: `${REFUSED} for ${host}` });
        if (res.status === 429 || res.status === 503) {
            const after = Number(res.headers.get('retry-after'));
            throw new RateLimited(
                now() + (Number.isFinite(after) && after > 0 ? after : 60) * 1000,
                `Jira: HTTP ${res.status} from ${host}`,
            );
        }
        if (!res.ok)
            throw new Error(
                `Jira: HTTP ${res.status} from ${host} ${(await res.text()).slice(0, 200)}`,
            );
        const body = (await res.json()) as {
            issues?: Issue[];
            issueErrors?: { errorMessage?: string }[];
        };
        const byKey = new Map((body.issues ?? []).map((i) => [i.key?.toUpperCase(), i]));
        // Jira leaves out an issue it can't find or show; an error it lists names an issue id.
        const failed = body.issueErrors?.[0]?.errorMessage;
        return links.map(({ url, key }) => {
            const issue = byKey.get(key);
            return [
                url,
                !issue && failed ? { error: `Jira: ${failed}` } : statusOf(issue, key),
            ] as const;
        });
    }

    return {
        name: 'jira',
        batchSize: 100,
        matches: (url) => jiraIssue(url) !== undefined,
        async fetch(urls, signal) {
            const bySite = new Map<string, { url: string; key: string }[]>();
            for (const url of urls) {
                const issue = jiraIssue(url);
                if (!issue) continue;
                const links = bySite.get(issue.site) ?? [];
                links.push({ url, key: issue.key });
                bySite.set(issue.site, links);
            }
            // A site at a time would wait on each; together, one site's rate limit fails the batch.
            const answers = await Promise.all(
                [...bySite].map(([site, links]) => fromSite(site, links, signal)),
            );
            return new Map(answers.flat());
        },
    };
}
