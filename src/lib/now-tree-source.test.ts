import { flattenForRender, InMemoryTreeSource } from '@grida/tree-view';
import { describe, expect, it } from 'vitest';
import { emptyNowTree, markNow, type NowTreeState, removeEntry, switchTo } from './now-tree';
import { buildNowTreeSource, expandedNowIds } from './now-tree-source';
import { buildNowTreeView, type NowRowView } from './now-tree-view-model';

const NOW = new Date('2026-06-04T12:00:00.000Z');

const mk = (s: NowTreeState, id: string): NowTreeState =>
    markNow(s, { entryId: id, id: `t-${id}`, markedAt: 'm' });

/** The compacted rows for a state (labels irrelevant to the source round-trip). */
const view = (s: NowTreeState): NowRowView[] => buildNowTreeView(s, () => undefined, NOW);

/** Project OUR rows as `id:depth[:container]` (container = isFork). */
function proj(rows: NowRowView[]): string[] {
    return rows.map((r) => `${r.entryId}:${r.depth}${r.isFork ? ':container' : ''}`);
}

/** Flatten our synthetic source through grida's real flatten → same projection. */
function flatten(rows: NowRowView[], expanded: string[] = expandedNowIds(rows)): string[] {
    const { root, nodes } = buildNowTreeSource(rows);
    const source = new InMemoryTreeSource({ root, nodes, showRoot: false });
    return flattenForRender(source, new Set(expanded)).map(
        (r) => `${r.id}:${r.depth}${r.isContainer ? ':container' : ''}`,
    );
}

describe('buildNowTreeSource — grida round-trip', () => {
    it('is empty for no rows', () => {
        expect(flatten([])).toEqual([]);
    });

    it('reproduces the §step-8 compacted tree through grida', () => {
        // A → {B → {C, D}, E}; current C. Compacted: C,B,D,A,E at depths 0,0,1,0,1.
        let s = mk(emptyNowTree(), 'A');
        s = mk(s, 'B');
        s = mk(s, 'C');
        s = switchTo(s, 'B');
        s = mk(s, 'D');
        s = switchTo(s, 'A');
        s = mk(s, 'E');
        s = switchTo(s, 'C');
        const rows = view(s);
        // grida's flatten of the synthetic tree === our own row projection …
        expect(flatten(rows)).toEqual(proj(rows));
        // … and both equal the known compacted shape (B, A are the forks).
        expect(flatten(rows)).toEqual(['C:0', 'B:0:container', 'D:1', 'A:0:container', 'E:1']);
    });

    it('keeps a linear offshoot as flat siblings (not a chain)', () => {
        // A → B → F → G linear; current A → offshoot B,F,G all at depth 1.
        let s = mk(emptyNowTree(), 'A');
        s = mk(s, 'B');
        s = mk(s, 'F');
        s = mk(s, 'G');
        s = switchTo(s, 'A');
        const rows = view(s);
        expect(flatten(rows)).toEqual(proj(rows));
        expect(flatten(rows)).toEqual(['A:0:container', 'B:1', 'F:1', 'G:1']);
    });

    it('reproduces the no-current forest', () => {
        let s = mk(emptyNowTree(), 'A');
        s = mk(s, 'B');
        s = switchTo(s, 'A');
        s = removeEntry(s, 'A'); // A gone, B a root, current → null
        const rows = view(s);
        expect(flatten(rows)).toEqual(proj(rows));
        expect(flatten(rows)).toEqual(['B:0']);
    });

    it('hides a fork’s offshoot when that fork is collapsed', () => {
        // §step-8 again, but expand only A → B stays a (collapsed) container, D hidden.
        let s = mk(emptyNowTree(), 'A');
        s = mk(s, 'B');
        s = mk(s, 'C');
        s = switchTo(s, 'B');
        s = mk(s, 'D');
        s = switchTo(s, 'A');
        s = mk(s, 'E');
        s = switchTo(s, 'C');
        const rows = view(s);
        expect(flatten(rows, ['A'])).toEqual([
            'C:0',
            'B:0:container', // still a container, just collapsed
            'A:0:container',
            'E:1', // A expanded → E shown; D hidden under collapsed B
        ]);
    });

    it('marks exactly the fork rows as the expanded set', () => {
        let s = mk(emptyNowTree(), 'A');
        s = mk(s, 'B');
        s = mk(s, 'C');
        s = switchTo(s, 'B');
        s = mk(s, 'D');
        s = switchTo(s, 'A');
        s = mk(s, 'E');
        s = switchTo(s, 'C');
        const rows = view(s);
        expect(expandedNowIds(rows).sort()).toEqual(['A', 'B']);
    });
});
