import { describe, expect, it } from 'vitest';
import { emptyNowTree, markNow, type NowTreeState, removeEntry, switchTo } from './now-tree';
import { layoutNowTree, type NowRow } from './now-tree-view-model';

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
});
