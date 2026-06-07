import { describe, expect, it, vi } from 'vitest';
import {
    clear,
    currentNowId,
    emptyNowTree,
    type MarkNowInput,
    markNow,
    NOW_TREE_VERSION,
    type NowTreeState,
    normalizeNowTreeState,
    pathToRoot,
    pruneChildren,
    pruneOffPath,
    pruneSubtree,
    removeEntry,
    switchTo,
} from './now-tree';

/** Build a mark input. `id` defaults to `task-<entryId>` (override to test @id recurrence). */
function mk(entryId: string, id = `task-${entryId}`, content?: string): MarkNowInput {
    return {
        entryId,
        id,
        markedAt: `m-${entryId}`,
        ...(content !== undefined ? { content } : {}),
    };
}

/** A comparable view of tree shape — entryIds present, the parent map, and current. */
function snap(s: NowTreeState) {
    return {
        ids: s.entries.map((e) => e.entryId).sort(),
        parents: Object.fromEntries(s.entries.map((e) => [e.entryId, e.parentId])),
        current: s.currentEntryId,
    };
}

describe('emptyNowTree', () => {
    it('is the current version, empty, with no current', () => {
        expect(emptyNowTree()).toEqual({
            version: NOW_TREE_VERSION,
            entries: [],
            currentEntryId: null,
        });
    });
});

describe('markNow', () => {
    it('marks a root into an empty tree', () => {
        const s = markNow(emptyNowTree(), mk('a'));
        expect(s.entries).toHaveLength(1);
        expect(s.entries[0]).toMatchObject({
            entryId: 'a',
            id: 'task-a',
            parentId: null,
            createdSeq: 0,
        });
        expect(s.currentEntryId).toBe('a');
    });

    it('appends a child of the current and advances the pointer + createdSeq', () => {
        let s = markNow(emptyNowTree(), mk('a'));
        s = markNow(s, mk('b'));
        expect(s.entries[1]).toMatchObject({ entryId: 'b', parentId: 'a', createdSeq: 1 });
        expect(s.currentEntryId).toBe('b');
    });

    it('keeps `content` only when supplied', () => {
        const withContent = markNow(emptyNowTree(), mk('a', 'task-a', 'snapshot'));
        expect(withContent.entries[0]).toHaveProperty('content', 'snapshot');
        const without = markNow(emptyNowTree(), mk('a'));
        expect(without.entries[0]).not.toHaveProperty('content');
    });

    it('re-marking the same @id from a fresh entryId makes a distinct node (recurrence)', () => {
        let s = markNow(emptyNowTree(), mk('e1', 'task-A'));
        s = markNow(s, mk('e2', 'task-B'));
        s = markNow(s, mk('e3', 'task-A')); // task-A again, new entryId
        expect(s.entries.map((e) => e.entryId)).toEqual(['e1', 'e2', 'e3']);
        expect(s.entries.filter((e) => e.id === 'task-A')).toHaveLength(2);
        expect(s.currentEntryId).toBe('e3');
    });
});

describe('switchTo', () => {
    const base = (() => {
        let s = markNow(emptyNowTree(), mk('a'));
        s = markNow(s, mk('b'));
        return s; // a → b, current b
    })();

    it('moves the pointer to an ancestor (undo) without deleting', () => {
        const s = switchTo(base, 'a');
        expect(s.currentEntryId).toBe('a');
        expect(s.entries).toHaveLength(2); // b kept
    });

    it('moves the pointer to a descendant (redo)', () => {
        const undone = switchTo(base, 'a');
        expect(switchTo(undone, 'b').currentEntryId).toBe('b');
    });

    it('is a same-state no-op when already current or unknown', () => {
        expect(switchTo(base, 'b')).toBe(base);
        expect(switchTo(base, 'nope')).toBe(base);
    });
});

describe('removeEntry', () => {
    // a → b → c, current c
    const chain = (() => {
        let s = markNow(emptyNowTree(), mk('a'));
        s = markNow(s, mk('b'));
        s = markNow(s, mk('c'));
        return s;
    })();

    it('re-parents the children of a removed middle node onto the grandparent', () => {
        const s = removeEntry(chain, 'b');
        expect(snap(s)).toEqual({ ids: ['a', 'c'], parents: { a: null, c: 'a' }, current: 'c' });
    });

    it('makes the children roots when the removed node was a root', () => {
        const s = removeEntry(chain, 'a');
        expect(snap(s).parents).toEqual({ b: null, c: 'b' });
    });

    it('re-homes current to the removed node parent when current is removed', () => {
        const s = removeEntry(chain, 'c');
        expect(s.currentEntryId).toBe('b');
    });

    it('leaves a non-empty forest with no current when the current root is removed', () => {
        const onlyRoot = markNow(emptyNowTree(), mk('a')); // current a, root
        const child = markNow(onlyRoot, mk('b')); // a → b, current b
        const backToA = switchTo(child, 'a'); // current a (root, has child b)
        const s = removeEntry(backToA, 'a');
        expect(s.entries).toHaveLength(1); // b survives as a root
        expect(s.currentEntryId).toBeNull();
    });

    it('is a same-state no-op for an absent entryId', () => {
        expect(removeEntry(chain, 'nope')).toBe(chain);
    });
});

describe('pruneSubtree', () => {
    // a → b → {c, d}, current c
    const tree = (() => {
        let s = markNow(emptyNowTree(), mk('a'));
        s = markNow(s, mk('b'));
        s = markNow(s, mk('c'));
        s = switchTo(s, 'b');
        s = markNow(s, mk('d'));
        s = switchTo(s, 'c');
        return s;
    })();

    it('drops the node and all descendants', () => {
        const s = pruneSubtree(tree, 'b');
        expect(snap(s).ids).toEqual(['a']);
    });

    it('re-homes current to the pruned node parent when current is inside', () => {
        const s = pruneSubtree(tree, 'b'); // current c is inside b's subtree
        expect(s.currentEntryId).toBe('a');
    });

    it('leaves current alone when it is outside the pruned subtree', () => {
        const s = pruneSubtree(switchTo(tree, 'a'), 'c'); // current a, prune leaf c
        expect(s.currentEntryId).toBe('a');
        expect(snap(s).ids).toEqual(['a', 'b', 'd']);
    });

    it('is a same-state no-op for an absent entryId', () => {
        expect(pruneSubtree(tree, 'nope')).toBe(tree);
    });
});

describe('pruneChildren', () => {
    // a → b → {c, d}, current c
    const tree = (() => {
        let s = markNow(emptyNowTree(), mk('a'));
        s = markNow(s, mk('b'));
        s = markNow(s, mk('c'));
        s = switchTo(s, 'b');
        s = markNow(s, mk('d'));
        s = switchTo(s, 'c');
        return s;
    })();

    it('drops descendants but keeps the node, re-homing current onto it', () => {
        const s = pruneChildren(tree, 'b');
        expect(snap(s)).toEqual({ ids: ['a', 'b'], parents: { a: null, b: 'a' }, current: 'b' });
    });

    it('is a same-state no-op on a leaf', () => {
        expect(pruneChildren(tree, 'c')).toBe(tree);
    });

    it('is a same-state no-op for an absent entryId', () => {
        expect(pruneChildren(tree, 'nope')).toBe(tree);
    });

    it('leaves current alone when it is not among the removed descendants', () => {
        const s = pruneChildren(switchTo(tree, 'd'), 'a'); // current d gets removed? d is under b under a
        // d IS a descendant of a → current re-homes to a
        expect(s.currentEntryId).toBe('a');
    });
});

describe('pruneOffPath', () => {
    // a → {b → {c, d}, e}, current c → path a,b,c
    const tree = (() => {
        let s = markNow(emptyNowTree(), mk('a'));
        s = markNow(s, mk('b'));
        s = markNow(s, mk('c'));
        s = switchTo(s, 'b');
        s = markNow(s, mk('d'));
        s = switchTo(s, 'a');
        s = markNow(s, mk('e'));
        s = switchTo(s, 'c');
        return s;
    })();

    it('keeps only the root→current path and leaves current unchanged', () => {
        const s = pruneOffPath(tree);
        expect(snap(s)).toEqual({
            ids: ['a', 'b', 'c'],
            parents: { a: null, b: 'a', c: 'b' },
            current: 'c',
        });
    });

    it('yields a linear chain — every node then has ≤1 child', () => {
        const s = pruneOffPath(tree);
        const childCounts = s.entries.map(
            (e) => s.entries.filter((c) => c.parentId === e.entryId).length,
        );
        expect(Math.max(...childCounts)).toBeLessThanOrEqual(1);
    });

    it('is a same-state no-op when nothing is current', () => {
        const noCurrent: NowTreeState = { ...tree, currentEntryId: null };
        expect(pruneOffPath(noCurrent)).toBe(noCurrent);
    });
});

describe('pathToRoot (shared by pruneOffPath + the view-model trunk)', () => {
    // a → b → c (each markNow childs the current); current = c.
    const chainState = (): NowTreeState => {
        let s = markNow(emptyNowTree(), mk('a'));
        s = markNow(s, mk('b'));
        return markNow(s, mk('c'));
    };

    it('returns the [entry, parent, …, root] chain as entries', () => {
        const chain = pathToRoot(chainState().entries, 'c');
        expect(chain.map((e) => e.entryId)).toEqual(['c', 'b', 'a']);
        expect(chain[0]?.id).toBe('task-c'); // entries, not ids
    });

    it('stops at the root', () => {
        expect(pathToRoot(chainState().entries, 'a').map((e) => e.entryId)).toEqual(['a']);
    });

    it('is empty for an unknown id', () => {
        expect(pathToRoot(chainState().entries, 'nope')).toEqual([]);
    });

    it('is cycle-safe — a parent cycle terminates without looping', () => {
        // Hand-forge a 2-node cycle (a↔b) the reducers would never build.
        const cyclic: NowTreeState = {
            version: NOW_TREE_VERSION,
            entries: [
                { entryId: 'a', id: 'task-a', markedAt: 'm', parentId: 'b', createdSeq: 0 },
                { entryId: 'b', id: 'task-b', markedAt: 'm', parentId: 'a', createdSeq: 1 },
            ],
            currentEntryId: 'a',
        };
        expect(pathToRoot(cyclic.entries, 'a').map((e) => e.entryId)).toEqual(['a', 'b']);
    });
});

describe('clear', () => {
    it('empties the tree but preserves version', () => {
        const s = markNow(emptyNowTree(), mk('a'));
        expect(clear(s)).toEqual({ version: NOW_TREE_VERSION, entries: [], currentEntryId: null });
    });
});

describe('currentNowId', () => {
    it('returns the current node task @id, or null when nothing is current', () => {
        const s = markNow(emptyNowTree(), mk('a', 'task-xyz'));
        expect(currentNowId(s)).toBe('task-xyz');
        expect(currentNowId(emptyNowTree())).toBeNull();
    });
});

describe('normalizeNowTreeState', () => {
    const good: NowTreeState = {
        version: NOW_TREE_VERSION,
        entries: [
            { entryId: 'a', id: 'task-a', markedAt: 'm', parentId: null, createdSeq: 0 },
            {
                entryId: 'b',
                id: 'task-b',
                markedAt: 'm',
                parentId: 'a',
                createdSeq: 1,
                content: 'snap',
            },
        ],
        currentEntryId: 'b',
    };

    it('passes a valid state through and sorts entries by createdSeq', () => {
        const shuffled = { ...good, entries: [good.entries[1], good.entries[0]] };
        const out = normalizeNowTreeState(shuffled);
        expect(out.entries.map((e) => e.entryId)).toEqual(['a', 'b']);
        expect(out.entries[1]).toHaveProperty('content', 'snap');
    });

    it.each([
        ['not an object', 42],
        ['wrong version', { version: 999, entries: [], currentEntryId: null }],
        ['entries not an array', { version: NOW_TREE_VERSION, entries: {}, currentEntryId: null }],
        [
            'bad entry field',
            { version: NOW_TREE_VERSION, entries: [{ entryId: 'a' }], currentEntryId: null },
        ],
        [
            'currentEntryId wrong type',
            { version: NOW_TREE_VERSION, entries: [], currentEntryId: 42 },
        ],
        [
            'entry not an object',
            { version: NOW_TREE_VERSION, entries: [null], currentEntryId: null },
        ],
        [
            'entry.markedAt wrong type',
            {
                version: NOW_TREE_VERSION,
                entries: [{ entryId: 'a', id: 'x', markedAt: 5, parentId: null, createdSeq: 0 }],
                currentEntryId: null,
            },
        ],
        [
            'entry.parentId wrong type',
            {
                version: NOW_TREE_VERSION,
                entries: [{ entryId: 'a', id: 'x', markedAt: 'm', parentId: 5, createdSeq: 0 }],
                currentEntryId: null,
            },
        ],
        [
            'entry.createdSeq not finite',
            {
                version: NOW_TREE_VERSION,
                entries: [
                    {
                        entryId: 'a',
                        id: 'x',
                        markedAt: 'm',
                        parentId: null,
                        createdSeq: Number.NaN,
                    },
                ],
                currentEntryId: null,
            },
        ],
        [
            'entry.content wrong type',
            {
                version: NOW_TREE_VERSION,
                entries: [
                    {
                        entryId: 'a',
                        id: 'x',
                        markedAt: 'm',
                        parentId: null,
                        createdSeq: 0,
                        content: 5,
                    },
                ],
                currentEntryId: null,
            },
        ],
        [
            'duplicate entryId',
            {
                version: NOW_TREE_VERSION,
                entries: [
                    { entryId: 'a', id: 'x', markedAt: 'm', parentId: null, createdSeq: 0 },
                    { entryId: 'a', id: 'y', markedAt: 'm', parentId: null, createdSeq: 1 },
                ],
                currentEntryId: null,
            },
        ],
        [
            'dangling parentId',
            {
                version: NOW_TREE_VERSION,
                entries: [
                    { entryId: 'a', id: 'x', markedAt: 'm', parentId: 'ghost', createdSeq: 0 },
                ],
                currentEntryId: null,
            },
        ],
        [
            'cycle',
            {
                version: NOW_TREE_VERSION,
                entries: [
                    { entryId: 'a', id: 'x', markedAt: 'm', parentId: 'b', createdSeq: 0 },
                    { entryId: 'b', id: 'y', markedAt: 'm', parentId: 'a', createdSeq: 1 },
                ],
                currentEntryId: null,
            },
        ],
        ['current not found', { version: NOW_TREE_VERSION, entries: [], currentEntryId: 'ghost' }],
    ])('discards a corrupt state (%s) to empty and warns', (_label, raw) => {
        const warn = vi.fn();
        expect(normalizeNowTreeState(raw, warn)).toEqual(emptyNowTree());
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0]?.[0]).toContain('now-tree');
    });

    it('does not require a warn callback', () => {
        expect(() => normalizeNowTreeState(42)).not.toThrow();
    });
});

describe('immutability', () => {
    it('reducers never mutate the input state', () => {
        let s = markNow(emptyNowTree(), mk('a'));
        s = markNow(s, mk('b'));
        const frozen = JSON.parse(JSON.stringify(s));
        markNow(s, mk('c'));
        switchTo(s, 'a');
        removeEntry(s, 'a');
        pruneSubtree(s, 'a');
        pruneChildren(s, 'a');
        pruneOffPath(s);
        clear(s);
        expect(JSON.parse(JSON.stringify(s))).toEqual(frozen);
    });
});

describe('Undo-tree by example (the plan walkthrough)', () => {
    it('replays the 13-step trace, asserting the tree + current at each step', () => {
        let s = emptyNowTree();
        expect(snap(s)).toEqual({ ids: [], parents: {}, current: null }); // 0

        s = markNow(s, mk('A')); // 1
        expect(snap(s)).toEqual({ ids: ['A'], parents: { A: null }, current: 'A' });

        s = markNow(s, mk('B')); // 2
        expect(snap(s)).toEqual({ ids: ['A', 'B'], parents: { A: null, B: 'A' }, current: 'B' });

        s = markNow(s, mk('C')); // 3
        expect(snap(s)).toEqual({
            ids: ['A', 'B', 'C'],
            parents: { A: null, B: 'A', C: 'B' },
            current: 'C',
        });

        s = switchTo(s, 'B'); // 4 — back 1; C kept
        expect(snap(s)).toEqual({
            ids: ['A', 'B', 'C'],
            parents: { A: null, B: 'A', C: 'B' },
            current: 'B',
        });

        s = markNow(s, mk('D')); // 5 — branch from B
        expect(snap(s)).toEqual({
            ids: ['A', 'B', 'C', 'D'],
            parents: { A: null, B: 'A', C: 'B', D: 'B' },
            current: 'D',
        });

        s = switchTo(s, 'A'); // 6 — back many
        expect(s.currentEntryId).toBe('A');

        s = markNow(s, mk('E')); // 7 — branch from A
        expect(snap(s)).toEqual({
            ids: ['A', 'B', 'C', 'D', 'E'],
            parents: { A: null, B: 'A', C: 'B', D: 'B', E: 'A' },
            current: 'E',
        });

        s = switchTo(s, 'C'); // 8 — redo into the abandoned branch
        expect(s.currentEntryId).toBe('C');

        s = pruneChildren(s, 'B'); // 9 — C, D gone; current re-homed C→B
        expect(snap(s)).toEqual({
            ids: ['A', 'B', 'E'],
            parents: { A: null, B: 'A', E: 'A' },
            current: 'B',
        });

        s = pruneOffPath(s); // 10 — drop E
        expect(snap(s)).toEqual({ ids: ['A', 'B'], parents: { A: null, B: 'A' }, current: 'B' });

        s = markNow(s, mk('F')); // 11
        expect(snap(s)).toEqual({
            ids: ['A', 'B', 'F'],
            parents: { A: null, B: 'A', F: 'B' },
            current: 'F',
        });

        s = pruneSubtree(s, 'B'); // 12 — B, F gone; current re-homed F→A
        expect(snap(s)).toEqual({ ids: ['A'], parents: { A: null }, current: 'A' });

        s = clear(s); // 13
        expect(snap(s)).toEqual({ ids: [], parents: {}, current: null });
    });
});
