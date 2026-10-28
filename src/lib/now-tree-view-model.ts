import { type CompactRow, compactSubtree } from './compact-forest';
import { formatRelativeTime } from './hover-logic';
import { MISSING_NOW_LABEL, type NowRow, type NowRowView, type ResolveContent } from './now-row';
import { type NowEntry, type NowTreeState, pathToRoot } from './now-tree';

// The row view-model types live in the leaf `now-row` module (no host-only
// imports, so the webview can consume them); re-exported here so callers keep a
// single "view model" entry point.
export { MISSING_NOW_LABEL, type NowRow, type NowRowView, type ResolveContent };

/**
 * Flatten the undo-tree to an ordered row list with LINEAR-COMPACTION (the
 * git-graph / undo-tree visualization): the root→current path renders as a FLAT
 * trunk (current row first, depth 0), and every off-trunk branch becomes a
 * collapsible offshoot indented under its fork — so `depth` tracks BRANCH
 * nesting, not chain length, and a mostly-linear history stays flat. A linear
 * offshoot also stays flat (at its depth); only real forks (≥2 children) indent.
 *
 * Rows are top-to-bottom render order. With no current (`currentEntryId` null —
 * e.g. after removing the current root) the forest renders as depth-0 offshoots
 * in `createdSeq` order, nothing highlighted.
 */
export function layoutNowTree(state: NowTreeState): NowRow[] {
    const rows: NowRow[] = [];
    const childrenByParent = groupChildren(state.entries);
    const childrenOf = (id: string | null): NowEntry[] => childrenByParent.get(id) ?? [];

    /** Emit an off-trunk subtree: a linear run stays flat; a fork indents (`compactSubtree`). */
    const emitOffshoot = (start: NowEntry, depth: number): void => {
        const out: CompactRow<NowEntry>[] = [];
        compactSubtree(start, depth, (e) => childrenOf(e.entryId), out);
        for (const r of out) rows.push(makeRow(r.node, r.depth, 'branch', r.isFork, false, false));
    };

    if (state.currentEntryId === null) {
        for (const root of childrenOf(null)) emitOffshoot(root, 0);
        return rows;
    }

    const trunk = pathToRoot(state.entries, state.currentEntryId);
    const onTrunk = new Set(trunk.map((e) => e.entryId));
    for (const node of trunk) {
        const offTrunk = childrenOf(node.entryId).filter((k) => !onTrunk.has(k.entryId));
        rows.push(
            makeRow(
                node,
                0,
                'trunk',
                offTrunk.length > 0,
                true,
                node.entryId === state.currentEntryId,
            ),
        );
        for (const child of offTrunk) emitOffshoot(child, 1);
    }
    return rows;
}

/**
 * Decorate the linear-compaction rows for rendering. For each node resolves
 * the display `label` (live workspace content ?? the mark-time snapshot ?? a
 * missing marker), its relative `when`, and whether the `@id` is still live.
 * Pure — the host injects `resolve` (`cache.lookupById`) and `now`, so the
 * webview receives a ready-to-render viewmodel over `postMessage`.
 */
export function buildNowTreeView(
    state: NowTreeState,
    resolve: ResolveContent,
    now: Date,
): NowRowView[] {
    const byId = new Map(state.entries.map((e) => [e.entryId, e]));
    return layoutNowTree(state).map((row) => {
        const entry = byId.get(row.entryId) as NowEntry;
        const live = resolve(entry.id);
        return {
            ...row,
            id: entry.id,
            label: live?.content ?? entry.content ?? MISSING_NOW_LABEL,
            when: formatRelativeTime(entry.markedAt, now),
            resolved: live !== undefined,
            marker: live?.marker,
        };
    });
}

function makeRow(
    entry: NowEntry,
    depth: number,
    kind: 'trunk' | 'branch',
    isFork: boolean,
    onCurrentPath: boolean,
    current: boolean,
): NowRow {
    return {
        entryId: entry.entryId,
        depth,
        kind,
        isFork,
        onCurrentPath,
        current,
    };
}

/** Children of each parent (`null` key = roots), sorted by `createdSeq`. */
function groupChildren(entries: NowEntry[]): Map<string | null, NowEntry[]> {
    const byParent = new Map<string | null, NowEntry[]>();
    for (const e of entries) {
        const list = byParent.get(e.parentId);
        if (list) list.push(e);
        else byParent.set(e.parentId, [e]);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.createdSeq - b.createdSeq);
    return byParent;
}
