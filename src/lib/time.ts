import { format } from 'date-fns';

/**
 * Format a Date as an ISO-8601 local timestamp with explicit timezone offset.
 *
 * Output: `YYYY-MM-DDTHH:mm:ss±HH:MM` — second precision, local TZ offset,
 * never `Z`. Example: `2026-05-24T15:00:30+08:00`.
 *
 * Second precision is intentional so two toggles within the same minute
 * produce distinct timestamps. The explicit offset — lowercase `xxx`, the
 * ISO-8601 extended offset that never collapses to `Z` — keeps timestamps
 * unambiguous when files travel across timezones.
 */
export function localTimestamp(date: Date = new Date()): string {
    return format(date, "yyyy-MM-dd'T'HH:mm:ssxxx");
}

/** Local calendar date `YYYY-MM-DD` — used for dated header comments (e.g. tags.yml batches). */
export function localDate(date: Date = new Date()): string {
    return format(date, 'yyyy-MM-dd');
}
