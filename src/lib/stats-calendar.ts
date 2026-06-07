import type { DayCount } from './stats-aggregation';

/**
 * One calendar cell, structurally `react-activity-calendar`'s `Activity` (date +
 * count + a 0..maxLevel intensity). Kept as a plain shape here so this pure
 * module never imports the rendering library.
 */
export interface CalendarDay {
    date: string;
    count: number;
    level: number;
}

/**
 * Shape a metric's sparse {@link DayCount}s into `react-activity-calendar` data:
 *
 * - drop days outside `[from, to]` (the calendar shows a fixed trailing window);
 * - assign each remaining day a `level` in `1..maxLevel` scaled to the busiest
 *   day (so the ramp always uses its full range), `0` for no activity;
 * - bracket the array with the range endpoints, because the calendar infers its
 *   span from the first/last entries and fills the gaps between as no-activity.
 *
 * Pure + library-agnostic: swapping the calendar component only touches the
 * webview, never this.
 */
export function toCalendarData(
    dayCounts: Iterable<DayCount>,
    range: { from: string; to: string },
    maxLevel = 4,
): CalendarDay[] {
    const { from, to } = range;
    // YYYY-MM-DD compares lexicographically == chronologically.
    const inRange = [...dayCounts].filter((d) => d.date >= from && d.date <= to);
    const max = Math.max(1, ...inRange.map((d) => d.count));

    const byDate = new Map<string, CalendarDay>();
    for (const { date, count } of inRange) {
        const level = count <= 0 ? 0 : Math.min(maxLevel, Math.ceil((count / max) * maxLevel));
        byDate.set(date, { date, count, level });
    }
    // Endpoints define the rendered span; only add them if no event lands there.
    if (!byDate.has(from)) byDate.set(from, { date: from, count: 0, level: 0 });
    if (!byDate.has(to)) byDate.set(to, { date: to, count: 0, level: 0 });

    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
