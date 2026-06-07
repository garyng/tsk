import { format, subDays } from 'date-fns';
import { MARKERS, type Marker } from './markers';
import { countTasksByMarker } from './markers-find-logic';
import { buildStatsSeries } from './stats-aggregation';
import type { StatsView, StatusTile } from './stats-protocol';

/** Inclusive trailing-year window ending at `today`, as `YYYY-MM-DD` bounds. */
function yearRange(today: Date): { from: string; to: string } {
    // 364 days back → a 365-day inclusive window (GitHub-style ~53 columns).
    return {
        from: format(subDays(today, 364), 'yyyy-MM-dd'),
        to: format(today, 'yyyy-MM-dd'),
    };
}

/**
 * Build the {@link StatsView} the panel posts: current-state count tiles (every
 * marker, in registry order, even at 0), the total, the per-metric day series
 * (from {@link buildStatsSeries}), and the calendar's trailing-year window.
 *
 * Pure — fed `cache.listAllTasks()` + `cache.listAllMetadata()` + `new Date()`
 * by the host. Structural inputs so it unit-tests without the cache.
 */
export function buildStatsView(
    tasks: Iterable<{ marker: Marker }>,
    metadata: Iterable<{ key: string; value: string | null }>,
    today: Date,
): StatsView {
    const taskList = [...tasks];
    const counts = countTasksByMarker(taskList);
    const tiles: StatusTile[] = MARKERS.map((def) => ({
        marker: def.name,
        label: def.label,
        count: counts.get(def.name) ?? 0,
    }));
    return {
        tiles,
        total: taskList.length,
        series: buildStatsSeries(metadata),
        range: yearRange(today),
    };
}
