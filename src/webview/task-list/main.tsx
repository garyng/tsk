import { rankItem } from '@tanstack/match-sorter-utils';
import {
    type ColumnDef,
    type ColumnFiltersState,
    type FilterFn,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    type SortingState,
    useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MARKERS, type Marker } from '../../lib/markers';
import { formatRelativeShort } from '../../lib/relative-time';
import type {
    TaskListHostToWebview,
    TaskListView,
    TaskListWebviewToHost,
    TaskRow,
} from '../../lib/task-list-protocol';
import chipStyles from '../shared/chip.css?raw';
import { injectStyle } from '../shared/inject-style';
import markerStyles from '../shared/marker.css?raw';
import styles from './task-list.css?raw';

/**
 * The Task-list webview client. Receives a host-built {@link TaskListView} (every
 * row, once) and renders a `@tanstack/react-table` table — fuzzy content search,
 * a sortable created column, status-chip quick-filters that drive the marker
 * column filter — windowed by `@tanstack/react-virtual`. All filter/sort/search
 * is client-side (no round-trip); a row click posts `jump`, which the host
 * re-resolves by `@id` and reveals.
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

const ROW_HEIGHT = 28;

/** Fuzzy text match (match-sorter), used as the global filter over the content column. */
const fuzzy: FilterFn<TaskRow> = (row, columnId, value) =>
    rankItem(String(row.getValue(columnId) ?? ''), String(value)).passed;

/** A row matches if its (single) marker is among the selected set. */
const markerInSet: FilterFn<TaskRow> = (row, columnId, value) =>
    (value as Marker[]).includes(row.getValue(columnId));

/** A row matches if it carries ANY of the selected tags (OR). */
const tagsIncludeSome: FilterFn<TaskRow> = (row, columnId, value) => {
    const selected = value as string[];
    if (!selected.length) return true;
    const tags = row.getValue<string[]>(columnId);
    return selected.some((t) => tags.includes(t));
};

/** Created sort key — parse to epoch; an unstamped row sorts oldest (bottom in desc). */
const createdEpoch = (iso: string | undefined): number => {
    if (!iso) return 0;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
};

function TaskList() {
    const [view, setView] = useState<TaskListView | null>(null);
    const [globalFilter, setGlobalFilter] = useState('');
    const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
    const [sorting, setSorting] = useState<SortingState>([{ id: 'created', desc: true }]);
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

    const columns = useMemo<ColumnDef<TaskRow>[]>(
        () => [
            {
                id: 'marker',
                accessorKey: 'marker',
                header: 'Status',
                enableGlobalFilter: false,
                enableSorting: false,
                filterFn: markerInSet,
                cell: ({ row }) => (
                    <span
                        className="tsk-marker"
                        data-marker={row.original.marker}
                        aria-hidden="true"
                    >
                        [{GLYPH[row.original.marker]}]
                    </span>
                ),
            },
            {
                id: 'content',
                accessorKey: 'content',
                header: 'Task',
                enableSorting: false,
                enableColumnFilter: false,
                cell: ({ row }) => row.original.content || '(empty)',
            },
            {
                id: 'tags',
                accessorKey: 'tags',
                header: 'Tags',
                enableGlobalFilter: false,
                enableSorting: false,
                filterFn: tagsIncludeSome,
                cell: ({ row }) =>
                    row.original.tags.map((t) => (
                        <span key={t} className="tsk-tag">
                            {t}
                        </span>
                    )),
            },
            {
                id: 'created',
                accessorKey: 'created',
                header: 'Created',
                enableGlobalFilter: false,
                enableColumnFilter: false,
                sortUndefined: 'last', // unstamped rows sink to the bottom in either direction
                sortingFn: (a, b) =>
                    createdEpoch(a.original.created) - createdEpoch(b.original.created),
                cell: ({ row }) =>
                    row.original.created
                        ? formatRelativeShort(row.original.created, new Date())
                        : '',
            },
            {
                id: 'loc',
                header: 'Location',
                enableGlobalFilter: false,
                enableSorting: false,
                enableColumnFilter: false,
                cell: ({ row }) => `${row.original.file}:${row.original.line + 1}`,
            },
        ],
        [],
    );

    const table = useReactTable({
        data: view?.rows ?? [],
        columns,
        state: { globalFilter, columnFilters, sorting },
        globalFilterFn: fuzzy,
        onGlobalFilterChange: setGlobalFilter,
        onColumnFiltersChange: setColumnFilters,
        onSortingChange: setSorting,
        getCoreRowModel: getCoreRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        getSortedRowModel: getSortedRowModel(),
    });

    const rows = table.getRowModel().rows;
    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12,
    });

    const markerCol = table.getColumn('marker');
    const markerFilter = (markerCol?.getFilterValue() as Marker[] | undefined) ?? [];
    const toggleMarker = (m: Marker): void => {
        const next = markerFilter.includes(m)
            ? markerFilter.filter((x) => x !== m)
            : [...markerFilter, m];
        markerCol?.setFilterValue(next.length ? next : undefined);
    };

    return (
        <main className="tsk-tasks">
            {view && (
                <div className="tsk-table__toolbar">
                    <input
                        className="tsk-search"
                        type="search"
                        placeholder="Search tasks…"
                        aria-label="Search task content"
                        value={globalFilter}
                        onChange={(e) => setGlobalFilter(e.target.value)}
                    />
                    <nav className="tsk-chips" aria-label="Filter by status">
                        <button
                            type="button"
                            className={`tsk-chip${markerFilter.length === 0 ? ' tsk-chip--active' : ''}`}
                            aria-pressed={markerFilter.length === 0}
                            onClick={() => markerCol?.setFilterValue(undefined)}
                        >
                            All <span className="tsk-chip__count">{view.total}</span>
                        </button>
                        {view.counts.map((c) => (
                            <button
                                type="button"
                                key={c.marker}
                                data-marker={c.marker}
                                className={`tsk-chip${markerFilter.includes(c.marker) ? ' tsk-chip--active' : ''}`}
                                aria-pressed={markerFilter.includes(c.marker)}
                                onClick={() => toggleMarker(c.marker)}
                            >
                                {c.label} <span className="tsk-chip__count">{c.count}</span>
                            </button>
                        ))}
                    </nav>
                </div>
            )}

            {view && (
                <div className="tsk-table__head">
                    {table.getHeaderGroups()[0]?.headers.map((header) => {
                        const sortDir = header.column.getIsSorted();
                        return (
                            <span key={header.id} className="tsk-th" data-col={header.column.id}>
                                {header.column.getCanSort() ? (
                                    <button
                                        type="button"
                                        className="tsk-th__btn"
                                        onClick={header.column.getToggleSortingHandler()}
                                    >
                                        {flexRender(
                                            header.column.columnDef.header,
                                            header.getContext(),
                                        )}
                                        <span className="tsk-th__sort" aria-hidden="true">
                                            {sortDir === 'asc'
                                                ? '▲'
                                                : sortDir === 'desc'
                                                  ? '▼'
                                                  : '↕'}
                                        </span>
                                    </button>
                                ) : (
                                    flexRender(header.column.columnDef.header, header.getContext())
                                )}
                            </span>
                        );
                    })}
                </div>
            )}

            <div className="tsk-table__scroll" ref={scrollRef}>
                {!view ? (
                    <p className="tsk-tasks__empty">Loading…</p>
                ) : rows.length === 0 ? (
                    <p className="tsk-tasks__empty">
                        {view.rows.length === 0 ? 'No tasks.' : 'No matching tasks.'}
                    </p>
                ) : (
                    <div
                        className="tsk-table__body"
                        style={{ height: `${virtualizer.getTotalSize()}px` }}
                    >
                        {virtualizer.getVirtualItems().map((vi) => {
                            const row = rows[vi.index];
                            if (!row) return null;
                            return (
                                <button
                                    type="button"
                                    key={row.id}
                                    className="tsk-row"
                                    data-marker={row.original.marker}
                                    style={{
                                        height: `${vi.size}px`,
                                        transform: `translateY(${vi.start}px)`,
                                    }}
                                    title={`${row.original.file}:${row.original.line + 1}`}
                                    onClick={() => post({ type: 'jump', id: row.original.id })}
                                >
                                    {row.getVisibleCells().map((cell) => (
                                        <span
                                            key={cell.id}
                                            className="tsk-cell"
                                            data-col={cell.column.id}
                                        >
                                            {flexRender(
                                                cell.column.columnDef.cell,
                                                cell.getContext(),
                                            )}
                                        </span>
                                    ))}
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
injectStyle('tsk-chip-style', chipStyles);
injectStyle('tsk-task-list-style', styles);

const container = document.getElementById('root');
if (container) {
    createRoot(container).render(
        <StrictMode>
            <TaskList />
        </StrictMode>,
    );
}
