import { useVirtualizer } from '@tanstack/react-virtual';
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MARKERS, type Marker } from '../../lib/markers';
import type {
    TaskListHostToWebview,
    TaskListView,
    TaskListWebviewToHost,
} from '../../lib/task-list-protocol';
import { injectStyle } from '../shared/inject-style';
import markerStyles from '../shared/marker.css?raw';
import styles from './task-list.css?raw';

/**
 * The Task-list webview client. Receives a host-built {@link TaskListView} (every
 * row, once) and renders status filter chips + a `@tanstack/react-virtual`-
 * windowed list. Filtering is local (no round-trip); a row click posts `jump`,
 * which the host re-resolves by `@id` and reveals.
 */

declare function acquireVsCodeApi(): {
    postMessage(message: TaskListWebviewToHost): void;
    getState(): unknown;
    setState(state: unknown): void;
};
const vscode = acquireVsCodeApi();
const post = (message: TaskListWebviewToHost): void => vscode.postMessage(message);

/** Canonical `[glyph]` per marker (e.g. todo → `[ ]`, in-progress → `[/]`). */
const GLYPH = Object.fromEntries(MARKERS.map((m) => [m.name, m.symbols[0]])) as Record<
    Marker,
    string
>;

type Filter = Marker | 'all';
const ROW_HEIGHT = 24;

function TaskList() {
    const [view, setView] = useState<TaskListView | null>(null);
    const [filter, setFilter] = useState<Filter>('all');
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onMessage = (event: MessageEvent): void => {
            const data = event.data as Partial<TaskListHostToWebview> | undefined;
            if (data?.type === 'render' && data.view) setView(data.view);
        };
        window.addEventListener('message', onMessage);
        post({ type: 'ready' });
        return () => window.removeEventListener('message', onMessage);
    }, []);

    const rows = useMemo(() => {
        if (!view) return [];
        return filter === 'all' ? view.rows : view.rows.filter((r) => r.marker === filter);
    }, [view, filter]);

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12,
    });

    return (
        <main className="tsk-tasks">
            {view && (
                <nav className="tsk-tasks__chips" aria-label="Filter by status">
                    <button
                        type="button"
                        className={`tsk-chip${filter === 'all' ? ' tsk-chip--active' : ''}`}
                        aria-pressed={filter === 'all'}
                        onClick={() => setFilter('all')}
                    >
                        All <span className="tsk-chip__count">{view.total}</span>
                    </button>
                    {view.counts.map((c) => (
                        <button
                            type="button"
                            key={c.marker}
                            data-marker={c.marker}
                            className={`tsk-chip${filter === c.marker ? ' tsk-chip--active' : ''}`}
                            aria-pressed={filter === c.marker}
                            onClick={() => setFilter(c.marker)}
                        >
                            {c.label} <span className="tsk-chip__count">{c.count}</span>
                        </button>
                    ))}
                </nav>
            )}

            <div className="tsk-tasks__scroll" ref={scrollRef}>
                {!view ? (
                    <p className="tsk-tasks__empty">Loading…</p>
                ) : rows.length === 0 ? (
                    <p className="tsk-tasks__empty">No tasks.</p>
                ) : (
                    <div
                        className="tsk-tasks__inner"
                        style={{ height: `${virtualizer.getTotalSize()}px` }}
                    >
                        {virtualizer.getVirtualItems().map((vi) => {
                            const row = rows[vi.index];
                            if (!row) return null;
                            return (
                                <button
                                    type="button"
                                    key={row.id}
                                    className="tsk-task"
                                    data-marker={row.marker}
                                    style={{
                                        height: `${vi.size}px`,
                                        transform: `translateY(${vi.start}px)`,
                                    }}
                                    title={`${row.file}:${row.line + 1}`}
                                    onClick={() => post({ type: 'jump', id: row.id })}
                                >
                                    <span className="tsk-marker" data-marker={row.marker}>
                                        [{GLYPH[row.marker]}]
                                    </span>
                                    <span className="tsk-task__content">
                                        {row.content || '(empty)'}
                                    </span>
                                    <span className="tsk-task__loc">
                                        {row.file}:{row.line + 1}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        </main>
    );
}

injectStyle('tsk-marker-style', markerStyles);
injectStyle('tsk-task-list-style', styles);

const container = document.getElementById('root');
if (container) {
    createRoot(container).render(
        <StrictMode>
            <TaskList />
        </StrictMode>,
    );
}
