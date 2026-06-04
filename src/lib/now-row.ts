/**
 * Row view-model types for the now-stack — deliberately a LEAF module with no
 * imports, so the webview bundle (and its DOM-only tsconfig) can pull these
 * types without dragging in the host-only chain behind `now-tree-view-model`
 * (`hover-logic` → `date-fns`, and `db`'s `node:sqlite`). The functions that
 * PRODUCE these rows (`layoutNowTree`, `buildNowTreeView`) stay host-side.
 */

/** One rendered row of the now-stack, after linear-compaction layout. */
export interface NowRow {
    entryId: string;
    parentId: string | null;
    /** Indent level: 0 = the flat current-path trunk; offshoots / forks deepen by 1. */
    depth: number;
    kind: 'trunk' | 'branch';
    /** Has rows rendered beneath it (off-trunk children on the trunk; ≥2 children off it) — a collapse point. */
    isFork: boolean;
    /** On the root→current trunk. */
    onCurrentPath: boolean;
    /** The current "now". */
    current: boolean;
}

/** Resolve a task `@id` to its live workspace record (the `cache.lookupById` shape). */
export type ResolveContent = (id: string) => { content: string } | undefined;

/** A `NowRow` decorated for rendering: resolved label, relative time, the task `@id`. */
export interface NowRowView extends NowRow {
    /** The task `@id` this node marks (may recur across nodes). */
    id: string;
    /** Live workspace content if resolvable, else the mark-time snapshot, else a missing marker. */
    label: string;
    /** Relative time of the mark, e.g. "3 minutes ago". */
    when: string;
    /** Whether the `@id` currently resolves in the workspace cache. */
    resolved: boolean;
}

/** Label shown when an `@id` resolves to neither a live task nor a snapshot. */
export const MISSING_NOW_LABEL = '(missing in workspace)';
