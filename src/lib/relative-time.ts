/**
 * Compact relative-time formatting for the task-list's created column — `just
 * now` / `10m ago` / `3h ago` / `2d ago` / `5w ago` / `8mo ago` / `2y ago`.
 *
 * A pure leaf (no `date-fns`, no host imports) so the webview bundle can call it
 * with `new Date()` each render and keep the column live without dragging a
 * date library into the browser bundle. Deliberately terser than the now-stack's
 * verbose `formatRelativeTime` ("10 minutes ago") — the task list wanted the
 * compact form.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Format `iso` (an ISO-8601 timestamp) as a compact "… ago" string relative to
 * `now`. Returns `''` for an unparseable input. A future stamp (clock skew)
 * reads as `just now`. Day-based buckets above a day, so the week→month→year
 * boundaries don't fight each other's flooring.
 */
export function formatRelativeShort(iso: string, now: Date): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const secs = Math.floor((now.getTime() - then) / 1000);
    if (secs < MINUTE) return 'just now';
    const mins = Math.floor(secs / MINUTE);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(secs / HOUR);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(secs / DAY);
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
}
