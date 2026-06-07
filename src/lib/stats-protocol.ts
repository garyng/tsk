/**
 * Message protocol + viewmodel for the Stats webview bridge — shared by the host
 * (`src/stats-panel.ts`) and the client (`src/webview/stats/main.tsx`).
 *
 * Lives in `src/lib/` so BOTH tsconfigs see it, and imports only the pure,
 * dependency-free `stats-aggregation` types — so pulling it into the webview
 * program drags nothing host-only (cf. the `now-row.ts` leaf rule).
 */

import type { DayCount, Metric } from './stats-aggregation';

/** One status's current count, for the header tiles. */
export interface StatusTile {
    /** Canonical marker name (`todo`, `inprogress`, …) — also the CSS `data-marker`. */
    marker: string;
    /** Human label from the marker registry, e.g. "In progress". */
    label: string;
    count: number;
}

/** The Stats viewmodel the host builds and posts; the webview renders it directly. */
export interface StatsView {
    /** Current-state counts (todo / in-progress / done / …) for the header strip. */
    tiles: StatusTile[];
    /** Total cached tasks across the workspace. */
    total: number;
    /**
     * Per-metric day buckets, including the combined `all`. Sparse (only days
     * with events). The webview's metric toggle picks one and shapes it into the
     * calendar's `data` client-side — no round-trip.
     */
    series: Record<Metric, DayCount[]>;
    /** Inclusive `YYYY-MM-DD` window the calendar spans (a trailing ~year). */
    range: { from: string; to: string };
}

/** Extension → webview. */
export type StatsHostToWebview = { type: 'render'; view: StatsView };

/**
 * Webview → extension. `ready` triggers the first render; `jumpToDay` (a calendar
 * day click) asks the host to open the task list filtered to that day's tasks for
 * the active `metric`.
 */
export type StatsWebviewToHost =
    | { type: 'ready' }
    | { type: 'jumpToDay'; date: string; metric: Metric };
