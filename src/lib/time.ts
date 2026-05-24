/**
 * Format a Date as an ISO-8601 local timestamp with explicit timezone offset.
 *
 * Output: `YYYY-MM-DDTHH:mm:ss±HH:MM` — second precision, local TZ offset,
 * never `Z`. Example: `2026-05-24T15:00:30+08:00`.
 *
 * Second precision is intentional so two toggles within the same minute
 * produce distinct timestamps. The explicit offset (instead of `Z` or no
 * suffix) makes timestamps unambiguous when files travel across timezones.
 */
export function localTimestamp(date: Date = new Date()): string {
    const pad = (n: number): string => n.toString().padStart(2, '0');
    const y = date.getFullYear();
    const mo = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const h = pad(date.getHours());
    const mi = pad(date.getMinutes());
    const se = pad(date.getSeconds());

    // getTimezoneOffset() returns minutes WEST of UTC, so UTC+8 → -480.
    // Flip the sign so positive offsets mean east-of-UTC (the convention).
    const offsetMin = -date.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const absOff = Math.abs(offsetMin);
    const offH = pad(Math.floor(absOff / 60));
    const offM = pad(absOff % 60);

    return `${y}-${mo}-${d}T${h}:${mi}:${se}${sign}${offH}:${offM}`;
}
