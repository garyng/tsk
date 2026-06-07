/**
 * Pure aggregation for the Stats webview's activity calendar.
 *
 * Task state-transitions persist ISO-8601-local timestamps as metadata
 * (`@created` on creation; `@started`/`@completed`/`@cancelled` on entering
 * `[/]`/`[x]`/`[!]`; `@moved` on `[>]` — see `toggle-mutators.ts`). This module
 * buckets those event timestamps by calendar day so the webview can paint a
 * GitHub-contributions-style heatmap, with a per-metric toggle plus a combined
 * "all activity" series.
 *
 * Library-agnostic by design: it emits plain `(date, count)` buckets. Mapping
 * counts → colour `level`s and filling the empty days of a date range is the
 * view-model's job (M2), so swapping the calendar component never touches this.
 *
 * Caveat (see plan `2026-06-07_tsk-webview-stats-lists.md`): these stamps are
 * best-effort, not an append-only event log — a hand-typed marker stamps
 * nothing, and `@started`/`@completed` are cleared on toggle-back. The calendar
 * reflects tasks *currently* bearing each stamp.
 */

/** Metadata keys carrying an event timestamp, in calendar-toggle display order. */
export const EVENT_METRICS = ['created', 'started', 'completed', 'cancelled', 'moved'] as const;

/** One timestamped event type — equal to its metadata key. */
export type EventMetric = (typeof EVENT_METRICS)[number];

/** A calendar series selector: a single event, or the combined "all activity". */
export type Metric = EventMetric | 'all';

/** One day's event count. `date` is a local `YYYY-MM-DD` (the stamped day). */
export interface DayCount {
    date: string;
    count: number;
}

const EVENT_METRIC_SET: ReadonlySet<string> = new Set(EVENT_METRICS);

/** Matches a leading `YYYY-MM-DD` — the date prefix of an ISO-8601 timestamp (`2026-05-24T15:00:30+08:00`). */
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/**
 * Bucket metadata rows whose `key` is in `keys` by their value's local calendar
 * day, returning `date → count`. Rows with a key outside `keys`, a `null` value,
 * or a malformed value are skipped.
 *
 * The day is the **written** date prefix, not a UTC re-projection — so an event
 * stamped late at night in one offset stays on the day the user saw when they
 * acted, matching the timestamp they'd read in the file.
 */
export function bucketByDay(
    metadata: Iterable<{ key: string; value: string | null }>,
    keys: ReadonlySet<string>,
): Map<string, number> {
    const buckets = new Map<string, number>();
    for (const { key, value } of metadata) {
        if (!keys.has(key) || value == null || !ISO_DATE_PREFIX.test(value)) continue;
        const date = value.slice(0, 10);
        buckets.set(date, (buckets.get(date) ?? 0) + 1);
    }
    return buckets;
}

/** A `date → count` map as a `DayCount[]` sorted ascending by date. */
function toDayCounts(buckets: Map<string, number>): DayCount[] {
    return [...buckets.entries()]
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Build every calendar series the Stats panel offers in one go over the
 * workspace metadata: one `DayCount[]` per {@link EVENT_METRICS} entry, plus a
 * combined `all` series counting any event per day. Each series is sorted by
 * date. The host sends them all at once; the webview's metric toggle just picks
 * which to render (no round-trip).
 */
export function buildStatsSeries(
    metadata: Iterable<{ key: string; value: string | null }>,
): Record<Metric, DayCount[]> {
    // Materialize once — the input may be a one-shot iterable, and we scan it
    // per metric below. At the documented < 1000-task scale this is trivial.
    const rows = [...metadata];
    const series = {} as Record<Metric, DayCount[]>;
    for (const metric of EVENT_METRICS) {
        series[metric] = toDayCounts(bucketByDay(rows, new Set([metric])));
    }
    series.all = toDayCounts(bucketByDay(rows, EVENT_METRIC_SET));
    return series;
}
