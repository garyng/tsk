/**
 * Message protocol + viewmodel for the Task-list webview bridge — shared by the
 * host (`src/task-list-panel.ts`) and client (`src/webview/task-list/main.tsx`).
 *
 * Lives in `src/lib/` so both tsconfigs see it, and imports only the pure
 * `Marker` type — so pulling it into the webview program drags nothing host-only
 * (cf. the leaf-type rule the other protocols follow).
 */

import type { Marker } from './markers';

/** One task row. `content` keeps its inline `#tags`; `file` is the display basename. */
export interface TaskRow {
    id: string;
    marker: Marker;
    content: string;
    file: string;
    /** Zero-indexed line, for the `file:line` label (the host re-resolves the jump by `id`). */
    line: number;
    /** The task's resolved `#tags` (sorted), for the tags column + its header filter. */
    tags: string[];
    /** Raw ISO-8601-local `@created` stamp (undefined when unstamped); the webview formats it to a compact relative time so it stays live. */
    created?: string;
}

/** Per-status count, for a filter chip. */
export interface TaskCount {
    marker: Marker;
    label: string;
    count: number;
}

/**
 * The viewmodel the host builds and posts; the webview filters (client-side) and
 * renders it. The host ships every row once — the chip filter never round-trips.
 */
export interface TaskListView {
    rows: TaskRow[];
    counts: TaskCount[];
    total: number;
}

/** Extension → webview. */
export type TaskListHostToWebview = { type: 'render'; view: TaskListView };

/** Webview → extension. `ready` triggers the first render; `jump` reveals a task by `@id`. */
export type TaskListWebviewToHost = { type: 'ready' } | { type: 'jump'; id: string };
