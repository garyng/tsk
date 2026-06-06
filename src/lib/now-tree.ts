/**
 * The "now" undo-tree — the pure, vscode-free data model behind the now-task
 * feature. A forest of {@link NowEntry} nodes linked by `parentId`, with one
 * `currentEntryId` marking the task you're working on *now*.
 *
 * Undo is non-destructive: {@link switchTo} only moves the pointer, so every
 * branch is preserved (and redo is just navigating back into one). Deletion is
 * always explicit — {@link removeEntry}, {@link pruneSubtree},
 * {@link pruneChildren}, {@link pruneOffPath}, {@link clear}.
 *
 * Every reducer is pure and returns a NEW state (the input is never mutated).
 * Node identity is the synthetic `entryId` (a task `@id` may recur across
 * nodes), and the caller supplies a fresh `entryId` + `markedAt` per mark, so
 * this module stays clock-/random-free and fully deterministic in tests.
 */

export const NOW_TREE_VERSION = 1;

export interface NowEntry {
    /** Synthetic node identity (a fresh `generateId()`); unique within the tree. */
    entryId: string;
    /** The marked task's `@id` — the only pointer used to resolve a live location. May recur across nodes. */
    id: string;
    /** When the mark happened (`localTimestamp()`); display only — NOT the ordering authority. */
    markedAt: string;
    /** `entryId` of the parent, or `null` for a root. */
    parentId: string | null;
    /** Monotonic insertion sequence; the canonical sibling order (survives serialization). */
    createdSeq: number;
    /** Optional display snapshot, kept only when the live cache can't resolve `id` (untitled / unscanned). */
    content?: string;
}

export interface NowTreeState {
    version: number;
    /** All nodes, in `createdSeq` order. */
    entries: NowEntry[];
    /** The current "now" node, or `null` when nothing is current. */
    currentEntryId: string | null;
}

/** The fields the caller supplies to {@link markNow}; `parentId` + `createdSeq` are derived. */
export interface MarkNowInput {
    entryId: string;
    id: string;
    markedAt: string;
    content?: string;
}

/** A fresh, empty tree. */
export function emptyNowTree(): NowTreeState {
    return { version: NOW_TREE_VERSION, entries: [], currentEntryId: null };
}

/**
 * Mark a task as the current now — appends a child of the current node (a root
 * when nothing is current) and moves the pointer to it. The caller must supply
 * a fresh `entryId`, so re-marking a task already in the tree creates a NEW
 * node (the `@id` recurs) rather than collapsing onto the existing one.
 */
export function markNow(state: NowTreeState, input: MarkNowInput): NowTreeState {
    const entry: NowEntry = {
        entryId: input.entryId,
        id: input.id,
        markedAt: input.markedAt,
        parentId: state.currentEntryId,
        createdSeq: nextSeq(state.entries),
        ...(input.content !== undefined ? { content: input.content } : {}),
    };
    return { ...state, entries: [...state.entries, entry], currentEntryId: entry.entryId };
}

/**
 * Move the current pointer to an existing node — the undo/redo primitive.
 * Non-destructive: no node is removed, so the branch you leave stays put. A
 * no-op (returns the same state) if `entryId` is already current or absent.
 */
export function switchTo(state: NowTreeState, entryId: string): NowTreeState {
    if (entryId === state.currentEntryId) return state;
    if (!state.entries.some((e) => e.entryId === entryId)) return state;
    return { ...state, currentEntryId: entryId };
}

/**
 * Remove a single node, re-parenting its children onto its own parent (so the
 * surrounding branches stay connected). If the removed node was current, the
 * pointer re-homes to its parent (which may be `null` — leaving a non-empty
 * forest with no current). A no-op if `entryId` is absent.
 */
export function removeEntry(state: NowTreeState, entryId: string): NowTreeState {
    const target = state.entries.find((e) => e.entryId === entryId);
    if (!target) return state;
    const entries = state.entries
        .filter((e) => e.entryId !== entryId)
        .map((e) => (e.parentId === entryId ? { ...e, parentId: target.parentId } : e));
    const currentEntryId =
        state.currentEntryId === entryId ? target.parentId : state.currentEntryId;
    return { ...state, entries, currentEntryId };
}

/**
 * Drop a node and its entire subtree. If current was anywhere inside, the
 * pointer re-homes to the pruned node's parent. A no-op if `entryId` is absent.
 */
export function pruneSubtree(state: NowTreeState, entryId: string): NowTreeState {
    const target = state.entries.find((e) => e.entryId === entryId);
    if (!target) return state;
    const removed = descendantIds(state.entries, entryId);
    removed.add(entryId);
    const entries = state.entries.filter((e) => !removed.has(e.entryId));
    const currentEntryId = currentInside(state.currentEntryId, removed)
        ? target.parentId
        : state.currentEntryId;
    return { ...state, entries, currentEntryId };
}

/**
 * Drop a node's descendants but keep the node itself. If current was among the
 * removed descendants, the pointer re-homes to the (surviving) node. A no-op if
 * the node is absent or already a leaf.
 */
export function pruneChildren(state: NowTreeState, entryId: string): NowTreeState {
    if (!state.entries.some((e) => e.entryId === entryId)) return state;
    const removed = descendantIds(state.entries, entryId);
    if (removed.size === 0) return state;
    const entries = state.entries.filter((e) => !removed.has(e.entryId));
    const currentEntryId = currentInside(state.currentEntryId, removed)
        ? entryId
        : state.currentEntryId;
    return { ...state, entries, currentEntryId };
}

/**
 * Keep only the root→current path, dropping every other branch — linearizes the
 * tree to the current line (every surviving node then has ≤1 child). Current is
 * unchanged. A no-op when nothing is current.
 */
export function pruneOffPath(state: NowTreeState): NowTreeState {
    if (state.currentEntryId === null) return state;
    if (!state.entries.some((e) => e.entryId === state.currentEntryId)) return state;
    const keep = new Set(pathToRoot(state.entries, state.currentEntryId).map((e) => e.entryId));
    const entries = state.entries.filter((e) => keep.has(e.entryId));
    return { ...state, entries };
}

/** Drop everything. Preserves `version`. */
export function clear(state: NowTreeState): NowTreeState {
    return { version: state.version, entries: [], currentEntryId: null };
}

/** The current node's task `@id`, or `null` when nothing is current (or it's gone). */
export function currentNowId(state: NowTreeState): string | null {
    if (state.currentEntryId === null) return null;
    const cur = state.entries.find((e) => e.entryId === state.currentEntryId);
    return cur ? cur.id : null;
}

/**
 * Validate an untrusted parsed value into a clean {@link NowTreeState}. On ANY
 * structural problem (wrong version, bad field, duplicate/dangling/cyclic
 * `entryId`, current pointing at nothing) it returns an empty tree and calls
 * `warn` with the reason — it never throws. Mirrors `parseTagsYaml`'s
 * "parse-to-empty, warn, keep running" contract so a hand-edited `state.db`
 * can't crash activation. Entries are returned sorted by `createdSeq`.
 */
export function normalizeNowTreeState(
    raw: unknown,
    warn?: (message: string) => void,
): NowTreeState {
    const fail = (reason: string): NowTreeState => {
        warn?.(`now-tree: discarding persisted state — ${reason}`);
        return emptyNowTree();
    };

    if (typeof raw !== 'object' || raw === null) return fail('not an object');
    const obj = raw as Record<string, unknown>;
    if (obj.version !== NOW_TREE_VERSION) return fail(`unsupported version ${String(obj.version)}`);
    if (!Array.isArray(obj.entries)) return fail('entries is not an array');
    if (obj.currentEntryId !== null && typeof obj.currentEntryId !== 'string') {
        return fail('currentEntryId is not a string or null');
    }

    const entries: NowEntry[] = [];
    const ids = new Set<string>();
    for (const item of obj.entries) {
        if (typeof item !== 'object' || item === null) return fail('entry is not an object');
        const e = item as Record<string, unknown>;
        if (typeof e.entryId !== 'string' || e.entryId === '') return fail('entry.entryId invalid');
        if (typeof e.id !== 'string' || e.id === '') return fail('entry.id invalid');
        if (typeof e.markedAt !== 'string') return fail('entry.markedAt invalid');
        if (e.parentId !== null && typeof e.parentId !== 'string')
            return fail('entry.parentId invalid');
        if (typeof e.createdSeq !== 'number' || !Number.isFinite(e.createdSeq)) {
            return fail('entry.createdSeq invalid');
        }
        if (e.content !== undefined && typeof e.content !== 'string')
            return fail('entry.content invalid');
        if (ids.has(e.entryId)) return fail(`duplicate entryId ${e.entryId}`);
        ids.add(e.entryId);
        entries.push({
            entryId: e.entryId,
            id: e.id,
            markedAt: e.markedAt,
            parentId: e.parentId as string | null,
            createdSeq: e.createdSeq,
            ...(e.content !== undefined ? { content: e.content as string } : {}),
        });
    }

    for (const e of entries) {
        if (e.parentId !== null && !ids.has(e.parentId))
            return fail(`dangling parentId ${e.parentId}`);
    }
    if (obj.currentEntryId !== null && !ids.has(obj.currentEntryId)) {
        return fail('currentEntryId not found');
    }
    if (hasCycle(entries)) return fail('parent cycle detected');

    entries.sort((a, b) => a.createdSeq - b.createdSeq);
    return { version: NOW_TREE_VERSION, entries, currentEntryId: obj.currentEntryId };
}

// ── internal helpers ────────────────────────────────────────────────────────

/** The next monotonic `createdSeq` (0 for an empty tree). */
function nextSeq(entries: NowEntry[]): number {
    return entries.reduce((max, e) => Math.max(max, e.createdSeq), -1) + 1;
}

function currentInside(currentEntryId: string | null, removed: Set<string>): boolean {
    return currentEntryId !== null && removed.has(currentEntryId);
}

/** Transitive descendants of `rootId` (excluding it). Cycle-safe. */
function descendantIds(entries: NowEntry[], rootId: string): Set<string> {
    const childrenByParent = new Map<string | null, string[]>();
    for (const e of entries) {
        const list = childrenByParent.get(e.parentId);
        if (list) list.push(e.entryId);
        else childrenByParent.set(e.parentId, [e.entryId]);
    }
    const out = new Set<string>();
    const stack = [...(childrenByParent.get(rootId) ?? [])];
    while (stack.length > 0) {
        const id = stack.pop() as string;
        if (out.has(id)) continue;
        out.add(id);
        const kids = childrenByParent.get(id);
        if (kids) stack.push(...kids);
    }
    return out;
}

/**
 * The chain `[entry, parent, …, root]` as entries, walking `parentId` up from
 * `entryId`. Cycle-safe (stops if the chain revisits a node) and stops at the
 * first absent node. Returns entries (not ids) so a caller needing the node
 * payload — the view-model's trunk — gets it; id-only callers `.map(e => e.entryId)`.
 * Shared by {@link pruneOffPath} and the view-model's `layoutNowTree` (the two
 * walks were byte-identical bar this return type).
 */
export function pathToRoot(entries: NowEntry[], entryId: string): NowEntry[] {
    const byId = new Map(entries.map((e) => [e.entryId, e]));
    const path: NowEntry[] = [];
    const seen = new Set<string>();
    let cur: string | null = entryId;
    while (cur !== null && !seen.has(cur)) {
        const entry = byId.get(cur);
        if (entry === undefined) break;
        path.push(entry);
        seen.add(cur);
        cur = entry.parentId;
    }
    return path;
}

/** True if any node's parent chain revisits a node (a cycle). */
function hasCycle(entries: NowEntry[]): boolean {
    const parentOf = new Map(entries.map((e) => [e.entryId, e.parentId]));
    for (const start of entries) {
        const seen = new Set<string>();
        let cur: string | null = start.entryId;
        while (cur !== null) {
            if (seen.has(cur)) return true;
            seen.add(cur);
            cur = parentOf.get(cur) ?? null;
        }
    }
    return false;
}
