/**
 * A link's status as a connector reports it, and how long tsk trusts it. Pure.
 */

/** What kind of state a status is: it picks the colour. */
export const CATEGORIES = ['open', 'inProgress', 'done', 'closed', 'unknown'] as const;
export type Category = (typeof CATEGORIES)[number];

/** A PR's CI checks, as one state. */
export const CHECKS = ['passing', 'failing', 'pending'] as const;
export type Checks = (typeof CHECKS)[number];

export interface LinkStatus {
    /** What's shown after the link: `merged`, `In Review`. */
    readonly label: string;
    readonly category: Category;
    readonly checks?: Checks;
    /** The item's own title, for the hover. */
    readonly title?: string;
    /** More for the hover, a line each. */
    readonly lines?: readonly string[];
}

/** What tsk knows about a URL: its status, or why it has none, and when that was found. */
export type Entry =
    | { readonly status: LinkStatus; readonly fetchedAt: number }
    | { readonly error: string; readonly fetchedAt: number };

const MINUTE = 60_000;
/** An open item changes often, a finished one rarely; an error is worth trying again soon. */
export const FRESH_FOR_MS: Readonly<Record<Category | 'error', number>> = {
    open: 5 * MINUTE,
    inProgress: 5 * MINUTE,
    unknown: 5 * MINUTE,
    done: 24 * 60 * MINUTE,
    closed: 24 * 60 * MINUTE,
    error: MINUTE,
};

export function isFresh(entry: Entry, now: number): boolean {
    const kind = 'status' in entry ? entry.status.category : 'error';
    return now - entry.fetchedAt < FRESH_FOR_MS[kind];
}

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
    typeof v === 'string' && (list as readonly string[]).includes(v);

/**
 * A status from a connector's answer for one URL (a JSON object), or why it
 * isn't one. Forgiving on what's optional: a bad `checks` or `lines` is
 * dropped, an unknown `category` is `unknown`; only a missing `label` refuses.
 */
export function readStatus(raw: unknown): LinkStatus | { why: string } {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return { why: 'not an object' };
    const r = raw as Record<string, unknown>;
    if (typeof r.label !== 'string' || r.label.trim() === '') return { why: 'no "label"' };
    const lines = Array.isArray(r.lines) ? r.lines.filter((l) => typeof l === 'string') : [];
    return {
        label: r.label.trim(),
        category: isOneOf(CATEGORIES, r.category) ? r.category : 'unknown',
        ...(isOneOf(CHECKS, r.checks) ? { checks: r.checks } : {}),
        ...(typeof r.title === 'string' && r.title !== '' ? { title: r.title } : {}),
        ...(lines.length > 0 ? { lines } : {}),
    };
}
