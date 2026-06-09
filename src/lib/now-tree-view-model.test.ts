import { describe, expect, it } from 'vitest';
import { bump, emptyNowTree, markNow, type NowTreeState, removeEntry, switchTo } from './now-tree';
import {
    buildNowTreeView,
    layoutNowTree,
    MISSING_NOW_LABEL,
    type NowRow,
    type NowRowView,
    type ResolveContent,
} from './now-tree-view-model';

/** Mark `entryId` as the current now (id = `t-<entryId>`, fixed timestamp). */
function mk(state: NowTreeState, entryId: string): NowTreeState {
    return markNow(state, { entryId, id: `t-${entryId}`, markedAt: 'm' });
}

/** Compact a row as `id:depth:kind[:cur][:fork]` for readable assertions. */
function proj(rows: NowRow[]): string[] {
    return rows.map(
        (r) =>
            `${r.entryId}:${r.depth}:${r.kind}${r.current ? ':cur' : ''}${r.isFork ? ':fork' : ''}`,
    );
}

describe('layoutNowTree — linear-compaction', () => {
    it('is empty for an empty tree', () => {
        expect(layoutNowTree(emptyNowTree())).toEqual([]);
    });

    it('renders a single root as the current trunk', () => {
        expect(proj(layoutNowTree(mk(emptyNowTree(), 'A')))).toEqual(['A:0:trunk:cur']);
    });

    it('keeps a linear chain FLAT (every node depth 0, current at top)', () => {
        // mark A → B → C; current = C. No branches → a flat trunk.
        let s = mk(emptyNowTree(), 'A');
        s = mk(s, 'B');
        s = mk(s, 'C');
        expect(proj(layoutNowTree(s))).toEqual(['C:0:trunk:cur', 'B:0:trunk', 'A:0:trunk']);
    });

    it('renders an off-path child as an offshoot under its fork (§step 4)', () => {
        // A → B → C, then switch back to B → C is off the A→B path.
        let s = mk(emptyNowTree(), 'A');
        s = mk(s, 'B');
        s = mk(s, 'C');
        s = switchTo(s, 'B');
        expect(proj(layoutNowTree(s))).toEqual(['B:0:trunk:cur:fork', 'C:1:branch', 'A:0:trunk']);
    });

    it('indents a real fork inside an offshoot (§step 6)', () => {
        // A → B → {C, D}; current = A → the whole B-branch is an offshoot, B forks.
        let s = mk(emptyNowTree(), 'A');
        s = mk(s, 'B');
        s = mk(s, 'C');
        s = switchTo(s, 'B');
        s = mk(s, 'D');
        s = switchTo(s, 'A');
        expect(proj(layoutNowTree(s))).toEqual([
            'A:0:trunk:cur:fork',
            'B:1:branch:fork',
            'C:2:branch',
            'D:2:branch',
        ]);
    });

    it('compacts the full §step-8 tree (two forks off the trunk)', () => {
        // A → {B → {C, D}, E}; current = C. Trunk C,B,A; D under B, E under A.
        let s = mk(emptyNowTree(), 'A');
        s = mk(s, 'B');
        s = mk(s, 'C');
        s = switchTo(s, 'B');
        s = mk(s, 'D');
        s = switchTo(s, 'A');
        s = mk(s, 'E');
        s = switchTo(s, 'C');
        expect(proj(layoutNowTree(s))).toEqual([
            'C:0:trunk:cur',
            'B:0:trunk:fork',
            'D:1:branch',
            'A:0:trunk:fork',
            'E:1:branch',
        ]);
    });

    it('keeps a LINEAR offshoot flat (no needless indentation)', () => {
        // A → B → F → G (linear); current = A → the B→F→G offshoot stays at depth 1.
        let s = mk(emptyNowTree(), 'A');
        s = mk(s, 'B');
        s = mk(s, 'F');
        s = mk(s, 'G');
        s = switchTo(s, 'A');
        expect(proj(layoutNowTree(s))).toEqual([
            'A:0:trunk:cur:fork',
            'B:1:branch',
            'F:1:branch',
            'G:1:branch',
        ]);
    });

    it('orders siblings by createdSeq within an offshoot', () => {
        // current A; A has two off-trunk children B (older) then C (newer).
        let s = mk(emptyNowTree(), 'A');
        s = mk(s, 'B'); // B child of A
        s = switchTo(s, 'A');
        s = mk(s, 'C'); // C child of A (newer)
        s = switchTo(s, 'A');
        expect(proj(layoutNowTree(s))).toEqual(['A:0:trunk:cur:fork', 'B:1:branch', 'C:1:branch']);
    });

    it('renders the forest as depth-0 offshoots when there is no current', () => {
        // Remove the current root → a non-empty forest with no current.
        let s = mk(emptyNowTree(), 'A');
        s = mk(s, 'B'); // A → B, current B
        s = switchTo(s, 'A'); // current A (root)
        s = removeEntry(s, 'A'); // A gone, B becomes a root, current → null
        expect(s.currentEntryId).toBeNull();
        expect(proj(layoutNowTree(s))).toEqual(['B:0:branch']);
    });

    it('flags onCurrentPath exactly for the trunk', () => {
        // §step-8 again: trunk = {C,B,A}; offshoots = {D,E}.
        let s = mk(emptyNowTree(), 'A');
        s = mk(s, 'B');
        s = mk(s, 'C');
        s = switchTo(s, 'B');
        s = mk(s, 'D');
        s = switchTo(s, 'A');
        s = mk(s, 'E');
        s = switchTo(s, 'C');
        const onPath = Object.fromEntries(
            layoutNowTree(s).map((r) => [r.entryId, r.onCurrentPath]),
        );
        expect(onPath).toEqual({ A: true, B: true, C: true, D: false, E: false });
    });

    // Render assertions for the owner's bump diagrams — proves the post-bump
    // trees draw exactly as drawn, under the UNCHANGED current-first layout.
    it('renders Example 3 — bump a fork node, children stay behind', () => {
        // A → B → {C, D}, current A; bump B. B floats to the top; C, D shed onto A.
        let s = mk(emptyNowTree(), 'A');
        s = mk(s, 'B');
        s = mk(s, 'C');
        s = switchTo(s, 'B');
        s = mk(s, 'D');
        s = switchTo(s, 'A');
        expect(proj(layoutNowTree(bump(s, 'B')))).toEqual([
            'B:0:trunk:cur',
            'A:0:trunk:fork',
            'C:1:branch',
            'D:1:branch',
        ]);
    });

    it('renders Example 4 — bump an ancestor twice, nothing disappears', () => {
        // A → B → C, B → D, A → E, current C.
        let s = mk(emptyNowTree(), 'A');
        s = mk(s, 'B');
        s = mk(s, 'C');
        s = switchTo(s, 'B');
        s = mk(s, 'D');
        s = switchTo(s, 'A');
        s = mk(s, 'E');
        s = switchTo(s, 'C');

        const afterA = bump(s, 'A'); // A to the top; B keeps the trunk, E follows it
        expect(proj(layoutNowTree(afterA))).toEqual([
            'A:0:trunk:cur',
            'C:0:trunk',
            'B:0:trunk:fork',
            'D:1:branch',
            'E:1:branch',
        ]);

        expect(proj(layoutNowTree(bump(afterA, 'B')))).toEqual([
            'B:0:trunk:cur',
            'A:0:trunk',
            'C:0:trunk:fork',
            'D:1:branch',
            'E:1:branch',
        ]);
    });
});

describe('buildNowTreeView — label + relative time', () => {
    const FIXED_NOW = new Date('2026-06-04T12:00:00.000Z');
    const noResolve: ResolveContent = () => undefined;

    /** Assert exactly one row and return it (narrows `T | undefined` for strict indexing). */
    function only(rows: NowRowView[]): NowRowView {
        expect(rows).toHaveLength(1);
        const [row] = rows;
        if (!row) throw new Error('expected exactly one row');
        return row;
    }

    it('prefers live workspace content over the mark-time snapshot', () => {
        const s = markNow(emptyNowTree(), {
            entryId: 'A',
            id: 't-A',
            markedAt: 'm',
            content: 'snapshot A',
        });
        const resolve: ResolveContent = (id) => (id === 't-A' ? { content: 'live A' } : undefined);
        const row = only(buildNowTreeView(s, resolve, FIXED_NOW));
        expect(row.label).toBe('live A');
        expect(row.resolved).toBe(true);
        expect(row.id).toBe('t-A');
    });

    it('carries the resolved task marker (undefined when unresolved)', () => {
        const s = markNow(emptyNowTree(), {
            entryId: 'A',
            id: 't-A',
            markedAt: 'm',
            content: 'snap',
        });
        const resolve: ResolveContent = (id) =>
            id === 't-A' ? { content: 'live', marker: 'completed' } : undefined;
        expect(only(buildNowTreeView(s, resolve, FIXED_NOW)).marker).toBe('completed');
        expect(only(buildNowTreeView(s, noResolve, FIXED_NOW)).marker).toBeUndefined();
    });

    it('falls back to the snapshot when the id is not live', () => {
        const s = markNow(emptyNowTree(), {
            entryId: 'A',
            id: 't-A',
            markedAt: 'm',
            content: 'snapshot A',
        });
        const row = only(buildNowTreeView(s, noResolve, FIXED_NOW));
        expect(row.label).toBe('snapshot A');
        expect(row.resolved).toBe(false);
    });

    it('shows the missing marker when neither live nor snapshot exists', () => {
        const s = mk(emptyNowTree(), 'A'); // mk records no content snapshot
        const row = only(buildNowTreeView(s, noResolve, FIXED_NOW));
        expect(row.label).toBe(MISSING_NOW_LABEL);
        expect(row.resolved).toBe(false);
    });

    it('formats `when` as relative time', () => {
        const s = markNow(emptyNowTree(), {
            entryId: 'A',
            id: 't-A',
            markedAt: '2026-06-04T11:55:00.000Z',
        });
        const row = only(buildNowTreeView(s, noResolve, FIXED_NOW));
        expect(row.when).toBe('5 minutes ago');
    });

    it('passes an unparseable markedAt through as `when`', () => {
        const s = mk(emptyNowTree(), 'A'); // markedAt: 'm'
        const row = only(buildNowTreeView(s, noResolve, FIXED_NOW));
        expect(row.when).toBe('m');
    });

    it('renders a recurring @id as distinct rows that both resolve', () => {
        // Two nodes mark the SAME @id (recurrence) → two rows, same id, both live.
        let s = markNow(emptyNowTree(), { entryId: 'A', id: 'dup', markedAt: 'm' });
        s = markNow(s, { entryId: 'B', id: 'dup', markedAt: 'm' }); // child, same @id
        const resolve: ResolveContent = (id) =>
            id === 'dup' ? { content: 'the task' } : undefined;
        const rows = buildNowTreeView(s, resolve, FIXED_NOW);
        expect(rows.map((r) => r.entryId)).toEqual(['B', 'A']); // current-first trunk
        expect(rows.every((r) => r.id === 'dup' && r.label === 'the task' && r.resolved)).toBe(
            true,
        );
    });

    it('preserves the layout topology (depth/kind/current) from layoutNowTree', () => {
        let s = mk(emptyNowTree(), 'A');
        s = mk(s, 'B');
        s = switchTo(s, 'A'); // current A, B an offshoot
        const rows = buildNowTreeView(s, noResolve, FIXED_NOW);
        expect(
            rows.map((r) => `${r.entryId}:${r.depth}:${r.kind}${r.current ? ':cur' : ''}`),
        ).toEqual(['A:0:trunk:cur', 'B:1:branch']);
    });
});
