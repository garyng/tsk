import type { NowEntry, NowTreeState } from './now-tree';

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

    /** Emit an off-trunk subtree: a linear run stays flat (loop); a fork indents (recurse). */
    const emitOffshoot = (start: NowEntry, depth: number): void => {
        let entry: NowEntry | undefined = start;
        while (entry) {
            const kids = childrenOf(entry.entryId);
            rows.push(makeRow(entry, depth, 'branch', kids.length >= 2, false, false));
            if (kids.length === 1) {
                entry = kids[0]; // linear → keep the same depth
            } else {
                for (const kid of kids) emitOffshoot(kid, depth + 1); // fork → indent
                entry = undefined;
            }
        }
    };

    if (state.currentEntryId === null) {
        for (const root of childrenOf(null)) emitOffshoot(root, 0);
        return rows;
    }

    const trunk = pathFromCurrentToRoot(state.entries, state.currentEntryId);
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
        parentId: entry.parentId,
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

/** `[current, parent, …, root]` as entries. Cycle-safe; stops at the first absent node. */
function pathFromCurrentToRoot(entries: NowEntry[], currentEntryId: string): NowEntry[] {
    const byId = new Map(entries.map((e) => [e.entryId, e]));
    const path: NowEntry[] = [];
    const seen = new Set<string>();
    let cur: string | null = currentEntryId;
    while (cur !== null && byId.has(cur) && !seen.has(cur)) {
        const entry = byId.get(cur) as NowEntry;
        path.push(entry);
        seen.add(cur);
        cur = entry.parentId;
    }
    return path;
}
