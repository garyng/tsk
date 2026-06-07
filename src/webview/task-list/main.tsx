import { rankItem } from '@tanstack/match-sorter-utils';
import {
    type ColumnDef,
    type ColumnFiltersState,
    type FilterFn,
    flexRender,
    getCoreRowModel,
    getFacetedRowModel,
    getFacetedUniqueValues,
    getFilteredRowModel,
    getSortedRowModel,
    type SortingState,
    useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type MouseEvent, StrictMode, useEffect, useMemo, useRef, useState } from 'react';
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
 * a sortable created column, Excel-style header filters on the Status + Tags
 * columns (the status chips are quick-filters over the same marker filter) —
 * windowed by `@tanstack/react-virtual`. All filter/sort/search is client-side
 * (no round-trip); a row click posts `jump`, which the host re-resolves and reveals.
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
/** Columns that carry an Excel-style header filter dropdown. */
const FILTERABLE = new Set(['marker', 'tags']);
/** Popover width (px) — used to clamp it on-screen. Keep in sync with `.tsk-filter`. */
const POPOVER_WIDTH = 220;

/** One row in a header filter dropdown — a faceted value with its count. */
interface FilterOption {
    value: string;
    label: string;
    count: number;
}

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
    const [openFilter, setOpenFilter] = useState<{ col: 'marker' | 'tags'; rect: DOMRect } | null>(
        null,
    );
    const scrollRef = useRef<HTMLDivElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onMessage = (event: MessageEvent): void => {
            const data = event.data as Partial<TaskListHostToWebview> | undefined;
            if (data?.type === 'render' && data.view) setView(data.view);
        };
        window.addEventListener('message', onMessage);
        post({ type: 'ready' });
        return () => window.removeEventListener('message', onMessage);
    }, []);

    // Close the open dropdown on an outside click or Escape. A click on any filter
    // trigger is left for that button's own toggle handler.
    useEffect(() => {
        if (!openFilter) return;
        const onDown = (e: globalThis.MouseEvent): void => {
            const t = e.target as HTMLElement | null;
            if (popoverRef.current?.contains(t) || t?.closest('.tsk-th__filter')) return;
            setOpenFilter(null);
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') setOpenFilter(null);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [openFilter]);

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
                // Facet over individual tags, not the whole array, so the dropdown
                // lists each #tag with its own count.
                getUniqueValues: (row) => row.tags,
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
        getFacetedRowModel: getFacetedRowModel(),
        getFacetedUniqueValues: getFacetedUniqueValues(),
    });

    const rows = table.getRowModel().rows;
    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12,
    });

    const filterOf = (col: 'marker' | 'tags'): string[] =>
        (table.getColumn(col)?.getFilterValue() as string[] | undefined) ?? [];
    const toggleInColumn = (col: 'marker' | 'tags', value: string): void => {
        const cur = filterOf(col);
        const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
        table.getColumn(col)?.setFilterValue(next.length ? next : undefined);
    };
    const markerFilter = filterOf('marker');

    // Marker dropdown lists every status (registry order, matching the chips);
    // tags dropdown is faceted off the live data.
    const markerOptions: FilterOption[] = (view?.counts ?? []).map((c) => ({
        value: c.marker,
        label: c.label,
        count: c.count,
    }));
    const tagFacets = table.getColumn('tags')?.getFacetedUniqueValues();
    const tagOptions: FilterOption[] = useMemo(
        () =>
            [...(tagFacets?.entries() ?? [])]
                .map(([value, count]) => ({ value: String(value), label: String(value), count }))
                .sort((a, b) => a.value.localeCompare(b.value)),
        [tagFacets],
    );

    const openMenu = (col: 'marker' | 'tags', e: MouseEvent<HTMLButtonElement>): void => {
        const rect = e.currentTarget.getBoundingClientRect();
        setOpenFilter((cur) => (cur?.col === col ? null : { col, rect }));
    };

    const anyFilter = columnFilters.length > 0 || globalFilter.length > 0;

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
                            onClick={() => table.getColumn('marker')?.setFilterValue(undefined)}
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
                                onClick={() => toggleInColumn('marker', c.marker)}
                            >
                                {c.label} <span className="tsk-chip__count">{c.count}</span>
                            </button>
                        ))}
                    </nav>
                    {anyFilter && (
                        <button
                            type="button"
                            className="tsk-clear"
                            onClick={() => {
                                setColumnFilters([]);
                                setGlobalFilter('');
                            }}
                        >
                            Clear filters
                        </button>
                    )}
                </div>
            )}

            {view && (
                <div className="tsk-table__head">
                    {table.getHeaderGroups()[0]?.headers.map((header) => {
                        const col = header.column;
                        const label = flexRender(col.columnDef.header, header.getContext());
                        const sortDir = col.getIsSorted();
                        const active = FILTERABLE.has(col.id)
                            ? filterOf(col.id as 'marker' | 'tags')
                            : [];
                        return (
                            <span key={header.id} className="tsk-th" data-col={col.id}>
                                {FILTERABLE.has(col.id) ? (
                                    <button
                                        type="button"
                                        className={`tsk-th__filter${active.length ? ' tsk-th__filter--active' : ''}`}
                                        aria-expanded={openFilter?.col === col.id}
                                        onClick={(e) => openMenu(col.id as 'marker' | 'tags', e)}
                                    >
                                        <span className="tsk-th__label">{label}</span>
                                        {active.length > 0 && (
                                            <span className="tsk-th__badge">{active.length}</span>
                                        )}
                                        <span className="tsk-th__caret" aria-hidden="true">
                                            ▾
                                        </span>
                                    </button>
                                ) : col.getCanSort() ? (
                                    <button
                                        type="button"
                                        className="tsk-th__btn"
                                        onClick={col.getToggleSortingHandler()}
                                    >
                                        <span className="tsk-th__label">{label}</span>
                                        <span className="tsk-th__sort" aria-hidden="true">
                                            {sortDir === 'asc'
                                                ? '▲'
                                                : sortDir === 'desc'
                                                  ? '▼'
                                                  : '↕'}
                                        </span>
                                    </button>
                                ) : (
                                    <span className="tsk-th__label">{label}</span>
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

            {openFilter && (
                <div
                    ref={popoverRef}
                    className="tsk-filter"
                    style={{
                        top: `${openFilter.rect.bottom + 4}px`,
                        left: `${Math.max(8, Math.min(openFilter.rect.left, window.innerWidth - POPOVER_WIDTH - 8))}px`,
                    }}
                >
                    <FilterMenu
                        options={openFilter.col === 'marker' ? markerOptions : tagOptions}
                        selected={new Set(filterOf(openFilter.col))}
                        searchable={openFilter.col === 'tags'}
                        onToggle={(v) => toggleInColumn(openFilter.col, v)}
                        onClear={() => table.getColumn(openFilter.col)?.setFilterValue(undefined)}
                    />
                </div>
            )}
        </main>
    );
}

function FilterMenu({
    options,
    selected,
    searchable,
    onToggle,
    onClear,
}: {
    options: FilterOption[];
    selected: Set<string>;
    searchable: boolean;
    onToggle: (value: string) => void;
    onClear: () => void;
}) {
    const [q, setQ] = useState('');
    const searchRef = useRef<HTMLInputElement>(null);
    // Focus the search box when the menu opens (it remounts per open).
    useEffect(() => {
        searchRef.current?.focus();
    }, []);
    const shown =
        searchable && q
            ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()))
            : options;
    return (
        <>
            {searchable && (
                <input
                    ref={searchRef}
                    className="tsk-filter__search"
                    type="search"
                    placeholder="Filter values…"
                    aria-label="Filter values"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                />
            )}
            <div className="tsk-filter__list">
                {shown.length === 0 ? (
                    <p className="tsk-filter__empty">No values.</p>
                ) : (
                    shown.map((o) => (
                        <label key={o.value} className="tsk-filter__item">
                            <input
                                type="checkbox"
                                checked={selected.has(o.value)}
                                onChange={() => onToggle(o.value)}
                            />
                            <span className="tsk-filter__label">{o.label}</span>
                            <span className="tsk-filter__count">{o.count}</span>
                        </label>
                    ))
                )}
            </div>
            <div className="tsk-filter__foot">
                <button
                    type="button"
                    className="tsk-filter__clear"
                    disabled={selected.size === 0}
                    onClick={onClear}
                >
                    Clear
                </button>
            </div>
        </>
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
