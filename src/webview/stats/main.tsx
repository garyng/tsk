import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityCalendar } from 'react-activity-calendar';
import { createRoot } from 'react-dom/client';
import { MARKERS, type Marker } from '../../lib/markers';
import { EVENT_METRICS, type Metric } from '../../lib/stats-aggregation';
import { toCalendarData } from '../../lib/stats-calendar';
import type { StatsHostToWebview, StatsView, StatsWebviewToHost } from '../../lib/stats-protocol';
import chipStyles from '../shared/chip.css?raw';
import { injectStyle } from '../shared/inject-style';
import markerStyles from '../shared/marker.css?raw';
import styles from './stats.css?raw';

/**
 * The Stats webview client. Receives a host-built {@link StatsView} over the
 * `render` bridge and shows current-state count tiles + a GitHub-style activity
 * calendar (`react-activity-calendar`). The metric toggle is purely local — it
 * re-shapes the already-sent `series` into the calendar's `data`, no round-trip.
 */

declare function acquireVsCodeApi(): {
    postMessage(message: StatsWebviewToHost): void;
    getState(): unknown;
    setState(state: unknown): void;
};
const vscode = acquireVsCodeApi();
const post = (message: StatsWebviewToHost): void => vscode.postMessage(message);

/** Toggle order: the combined view first, then each event stream. */
const METRICS: Metric[] = ['all', ...EVENT_METRICS];
const METRIC_LABEL: Record<Metric, string> = {
    all: 'All',
    created: 'Created',
    started: 'Started',
    completed: 'Completed',
    cancelled: 'Cancelled',
    moved: 'Moved',
};

/** Canonical `[glyph]` per marker (e.g. todo → `[ ]`, completed → `[x]`). */
const GLYPH = Object.fromEntries(MARKERS.map((m) => [m.name, m.symbols[0]])) as Record<
    Marker,
    string
>;

/**
 * Tooltip text for a calendar day: the date, then a per-type breakdown one line
 * each ("2 created" / "1 completed"). With a metric selected only that type
 * shows; with `all`, every non-zero event type. "no activity" for an empty day.
 * `.react-activity-calendar__tooltip` sets `white-space: pre-line` so the `\n`s render.
 */
function dayTooltip(date: string, series: StatsView['series'], metric: Metric): string {
    const metrics = metric === 'all' ? EVENT_METRICS : [metric];
    const parts = metrics
        .map((m) => ({
            label: METRIC_LABEL[m],
            n: series[m].find((d) => d.date === date)?.count ?? 0,
        }))
        .filter((p) => p.n > 0)
        .map((p) => `${p.n} ${p.label.toLowerCase()}`);
    return [date, ...(parts.length ? parts : ['no activity'])].join('\n');
}

// Blue intensity ramp (levels 0..4) for light + dark. A first-guess palette —
// a fully `--vscode-*`-derived ramp is a deferred refinement (see plan M2 notes).
const THEME = {
    light: ['#ebedf0', '#cfe3ff', '#86b9ff', '#3b82f6', '#1d4ed8'],
    dark: ['#2d2d2d', '#0d3a6b', '#1f5ba8', '#3794ff', '#7db9ff'],
};

/** Match the calendar's scheme to the VS Code theme (the body carries the class). */
function detectColorScheme(): 'light' | 'dark' {
    return document.body.classList.contains('vscode-light') ? 'light' : 'dark';
}

// Fit-to-width sizing. `react-activity-calendar` has no responsive mode, so we
// measure the calendar container and scale the block size so all ~53 weeks fit
// its width (down to MIN_BLOCK-px squares); the library thins crowded month
// labels itself as the blocks shrink. Measuring `clientWidth` is loop-safe — the
// container is panel-width (a block element), and a horizontal scrollbar changes
// only its height, never the measured width.
const WEEKS = 53;
const BLOCK_MARGIN = 2;
const GUTTER_PX = 34; // weekday-label column + a little breathing room
const MIN_BLOCK = 3;
const MAX_BLOCK = 12;

function useFittedBlockSize(): [(el: HTMLElement | null) => void, number] {
    const [blockSize, setBlockSize] = useState(MAX_BLOCK);
    const observerRef = useRef<ResizeObserver | null>(null);
    // A CALLBACK ref (not a mount `useEffect`) so the observer attaches when the
    // calendar section actually mounts — which is AFTER the first render, since
    // the section only exists once a viewmodel arrives. A mount-time effect sees
    // a null ref and never observes; the calendar then never resizes.
    const ref = useCallback((el: HTMLElement | null): void => {
        observerRef.current?.disconnect();
        if (!el) return;
        const measure = (): void => {
            const width = el.clientWidth;
            if (!width) return;
            const fitted = Math.floor((width - GUTTER_PX) / WEEKS) - BLOCK_MARGIN;
            const next = Math.max(MIN_BLOCK, Math.min(MAX_BLOCK, fitted));
            setBlockSize((prev) => (prev === next ? prev : next));
        };
        measure();
        observerRef.current = new ResizeObserver(measure);
        observerRef.current.observe(el);
    }, []);
    return [ref, blockSize];
}

function Stats() {
    const [view, setView] = useState<StatsView | null>(null);
    const [metric, setMetric] = useState<Metric>('all');
    const [calendarRef, blockSize] = useFittedBlockSize();

    useEffect(() => {
        const onMessage = (event: MessageEvent): void => {
            const data = event.data as Partial<StatsHostToWebview> | undefined;
            if (data?.type === 'render' && data.view) setView(data.view);
        };
        window.addEventListener('message', onMessage);
        post({ type: 'ready' });
        return () => window.removeEventListener('message', onMessage);
    }, []);

    if (!view) {
        return (
            <main className="tsk-stats">
                <p className="tsk-stats__empty">Loading…</p>
            </main>
        );
    }

    const series = view.series[metric];
    const hasEvents = series.some((d) => d.count > 0);

    return (
        <main className="tsk-stats">
            <header className="tsk-stats__tiles">
                <div className="tsk-tile tsk-tile--total">
                    <span className="tsk-tile__count">{view.total}</span>
                    <span className="tsk-tile__label">Total</span>
                </div>
                {view.tiles.map((tile) => (
                    <div className="tsk-tile" key={tile.marker} data-marker={tile.marker}>
                        <span className="tsk-tile__count">{tile.count}</span>
                        <span className="tsk-tile__label">
                            <span
                                className="tsk-marker"
                                data-marker={tile.marker}
                                aria-hidden="true"
                            >
                                [{GLYPH[tile.marker as Marker]}]
                            </span>
                            {tile.label}
                        </span>
                    </div>
                ))}
            </header>

            <nav className="tsk-stats__toggle" aria-label="Activity metric">
                {METRICS.map((m) => (
                    <button
                        type="button"
                        key={m}
                        className={`tsk-chip${m === metric ? ' tsk-chip--active' : ''}`}
                        aria-pressed={m === metric}
                        onClick={() => setMetric(m)}
                    >
                        {METRIC_LABEL[m]}
                    </button>
                ))}
            </nav>

            <section className="tsk-stats__calendar" ref={calendarRef}>
                <ActivityCalendar
                    data={toCalendarData(series, view.range)}
                    theme={THEME}
                    colorScheme={detectColorScheme()}
                    maxLevel={4}
                    blockSize={blockSize}
                    blockMargin={BLOCK_MARGIN}
                    fontSize={12}
                    showTotalCount={false}
                    showWeekdayLabels
                    labels={{ legend: { less: 'Less', more: 'More' } }}
                    tooltips={{
                        activity: { text: (a) => dayTooltip(a.date, view.series, metric) },
                    }}
                />
                {!hasEvents && (
                    <p className="tsk-stats__note">
                        No <strong>{METRIC_LABEL[metric].toLowerCase()}</strong> events stamped in
                        the last year. Status timestamps are written when you toggle a task
                        (Alt+S/C/X) or mark it now — a hand-typed marker isn’t recorded, so this
                        reflects tasks currently bearing each stamp, not a full history.
                    </p>
                )}
            </section>
        </main>
    );
}

injectStyle('tsk-marker-style', markerStyles);
injectStyle('tsk-chip-style', chipStyles);
injectStyle('tsk-stats-style', styles);

const container = document.getElementById('root');
if (container) {
    createRoot(container).render(
        <StrictMode>
            <Stats />
        </StrictMode>,
    );
}
