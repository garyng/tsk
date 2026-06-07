import { StrictMode, useEffect, useState } from 'react';
import { ActivityCalendar } from 'react-activity-calendar';
import { createRoot } from 'react-dom/client';
import { EVENT_METRICS, type Metric } from '../../lib/stats-aggregation';
import { toCalendarData } from '../../lib/stats-calendar';
import type { StatsHostToWebview, StatsView, StatsWebviewToHost } from '../../lib/stats-protocol';

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

function Stats() {
    const [view, setView] = useState<StatsView | null>(null);
    const [metric, setMetric] = useState<Metric>('all');

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
                        <span className="tsk-tile__label">{tile.label}</span>
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

            <section className="tsk-stats__calendar">
                <ActivityCalendar
                    data={toCalendarData(series, view.range)}
                    theme={THEME}
                    colorScheme={detectColorScheme()}
                    maxLevel={4}
                    blockSize={11}
                    blockMargin={3}
                    showTotalCount={false}
                    showWeekdayLabels
                    labels={{ legend: { less: 'Less', more: 'More' } }}
                    tooltips={{
                        activity: {
                            text: (a) =>
                                `${a.count} ${a.count === 1 ? 'event' : 'events'} on ${a.date}`,
                        },
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

const STYLE = `
.tsk-stats { padding: 14px 18px; color: var(--vscode-foreground, #cccccc);
    font: var(--vscode-font-size, 13px) / 1.5 var(--vscode-font-family, system-ui, "Segoe UI", sans-serif); }
.tsk-stats__empty, .tsk-stats__note { color: var(--vscode-descriptionForeground, #8c8c8c); }
.tsk-stats__note { margin: 10px 0 0; font-size: 0.9em; max-width: 56ch; line-height: 1.5; }
.tsk-stats__tiles { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.tsk-tile { display: flex; flex-direction: column; gap: 2px; min-width: 68px; padding: 8px 12px;
    border-radius: 6px; background: var(--vscode-editorWidget-background, rgba(255,255,255,0.04));
    border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.08)); }
.tsk-tile__count { font-size: 1.5em; font-weight: 600; line-height: 1.1; }
.tsk-tile__label { font-size: 0.82em; color: var(--vscode-descriptionForeground, #8c8c8c); }
.tsk-tile[data-marker="todo"] .tsk-tile__count { color: var(--vscode-tsk-marker-todo, #e5c07b); }
.tsk-tile[data-marker="inprogress"] .tsk-tile__count { color: var(--vscode-tsk-marker-inprogress, #3794ff); }
.tsk-tile[data-marker="completed"] .tsk-tile__count { color: var(--vscode-tsk-marker-completed, #67c23a); }
.tsk-tile[data-marker="moved"] .tsk-tile__count { color: var(--vscode-tsk-marker-moved, #ff9d00); }
.tsk-tile[data-marker="cancelled"] .tsk-tile__count { color: var(--vscode-tsk-marker-cancelled, #9e9e9e); }
.tsk-tile[data-marker="notes"] .tsk-tile__count { color: var(--vscode-tsk-marker-notes, #bb6dd9); }
.tsk-stats__toggle { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 14px; }
.tsk-chip { padding: 3px 11px; border-radius: 999px; cursor: pointer; font: inherit; font-size: 0.9em;
    color: var(--vscode-foreground, #cccccc); border: 1px solid transparent;
    background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.08)); }
.tsk-chip:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.12)); }
.tsk-chip--active { background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff); }
.tsk-stats__calendar { overflow-x: auto; }
`;

function injectStyles(): void {
    if (document.getElementById('tsk-stats-style')) return;
    const el = document.createElement('style');
    el.id = 'tsk-stats-style';
    el.textContent = STYLE;
    document.head.appendChild(el);
}

injectStyles();

const container = document.getElementById('root');
if (container) {
    createRoot(container).render(
        <StrictMode>
            <Stats />
        </StrictMode>,
    );
}
