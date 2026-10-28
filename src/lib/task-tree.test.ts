import { describe, expect, it } from 'vitest';
import {
    buildTaskTree,
    indentLevel,
    isAncestorOrSelf,
    lookupId,
    outsideFileOf,
    pathTo,
    subtreeEnd,
    type TaskTree,
    type TreeNode,
    withOutside,
} from './task-tree';

const tree = (...lines: string[]): TaskTree => buildTaskTree(lines);
const at = (t: TaskTree, id: string): TreeNode => {
    const node = t.byId.get(id);
    if (!node) throw new Error(`no node ${id}`);
    return node;
};
const parentOf = (t: TaskTree, id: string) => t.byId.get(id)?.parent?.id;
const childIds = (t: TaskTree, id: string) => t.byId.get(id)?.children.map((c) => c.id);

describe('buildTaskTree', () => {
    it('reads parent and child from indentation', () => {
        const t = tree(
            '- [ ] plan <!-- @id:p -->',
            '  - [ ] phase <!-- @id:ph -->',
            '    - [ ] task <!-- @id:t -->',
            '  - [ ] phase two <!-- @id:ph2 -->',
            '- [ ] another root <!-- @id:r -->',
        );
        expect(t.roots.map((n) => n.id)).toEqual(['p', 'r']);
        expect(childIds(t, 'p')).toEqual(['ph', 'ph2']);
        expect(parentOf(t, 't')).toBe('ph');
        expect(pathTo(at(t, 't')).map((n) => n.id)).toEqual(['p', 'ph', 't']);
    });

    it('lets an explicit @parent beat indentation', () => {
        const t = tree(
            '- [ ] a <!-- @id:a -->',
            '  - [ ] b <!-- @id:b -->',
            '  - [ ] c, flat under b <!-- @id:c @parent:b -->',
        );
        expect(parentOf(t, 'c')).toBe('b');
        expect(childIds(t, 'a')).toEqual(['b']);
        expect(childIds(t, 'b')).toEqual(['c']);
    });

    it('falls back to indentation when @parent names a task that is not in the file', () => {
        const t = tree('- [ ] a <!-- @id:a -->', '  - [ ] b <!-- @id:b @parent:elsewhere -->');
        expect(parentOf(t, 'b')).toBe('a');
    });

    it('refuses an @parent that would make a cycle', () => {
        const t = tree('- [ ] a <!-- @id:a @parent:b -->', '  - [ ] b <!-- @id:b -->');
        expect(parentOf(t, 'a')).toBeUndefined();
        expect(parentOf(t, 'b')).toBe('a');
        const loop = tree('- [ ] x <!-- @id:x @parent:y -->', '- [ ] y <!-- @id:y @parent:x -->');
        const x = at(loop, 'x');
        const y = at(loop, 'y');
        expect(isAncestorOrSelf(x, x.parent) || isAncestorOrSelf(y, y.parent)).toBe(false);
        expect(loop.roots).toHaveLength(1);
    });

    it('closes open tasks at a divider and at prose of the same or lower indent', () => {
        const t = tree(
            '- [ ] a <!-- @id:a -->',
            '-later--------------------',
            '  - [ ] b <!-- @id:b -->',
            'some prose',
            '  - [ ] c <!-- @id:c -->',
        );
        expect(t.roots.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    });

    it('keeps tasks under a parent across blank lines and nested notes', () => {
        const t = tree(
            '- [ ] a <!-- @id:a -->',
            '',
            '  - a note bullet',
            '  - [ ] b <!-- @id:b -->',
        );
        expect(parentOf(t, 'b')).toBe('a');
    });

    it('gives a duplicated @id to its first occurrence', () => {
        const t = tree('- [ ] first <!-- @id:d -->', '- [ ] second <!-- @id:d -->');
        expect(t.byId.get('d')?.task.content).toBe('first');
        expect(t.nodes).toHaveLength(2);
    });

    it('measures nesting levels in two-column steps, a tab counting as one level', () => {
        const t = tree(
            '- [ ] a <!-- @id:a -->',
            '  - [ ] b <!-- @id:b -->',
            '\t\t- [ ] c <!-- @id:c -->',
        );
        expect(['a', 'b', 'c'].map((id) => indentLevel(at(t, id)))).toEqual([0, 1, 2]);
    });
});

describe('subtreeEnd', () => {
    it('covers the indented block and the flat @parent descendants that follow it', () => {
        const t = tree(
            '      - [ ] at the cap <!-- @id:cap -->',
            '        - a note under it',
            '      - [ ] flat child <!-- @id:k1 @parent:cap -->',
            '      - [ ] its flat child <!-- @id:k2 @parent:k1 -->',
            '',
            '      - [ ] an unrelated sibling <!-- @id:s -->',
        );
        expect(subtreeEnd(t, at(t, 'cap'))).toBe(3);
        expect(subtreeEnd(t, at(t, 'k1'))).toBe(3);
    });

    it('stops before trailing blank lines and at a divider', () => {
        const t = tree(
            '- [ ] a <!-- @id:a -->',
            '  - [ ] b <!-- @id:b -->',
            '',
            '-next---------',
            '  - [ ] c <!-- @id:c -->',
        );
        expect(subtreeEnd(t, at(t, 'a'))).toBe(1);
    });
});

describe('withOutside', () => {
    const own = tree('- [ ] here <!-- @id:a -->', '- [ ] shared <!-- @id:dup -->');
    const first = tree(
        '- [ ] backlog <!-- @id:b -->',
        '- [ ] theirs <!-- @id:dup -->',
        '- [ ] no id',
    );
    const second = tree('- [ ] later <!-- @id:b -->', '- [ ] more <!-- @id:c -->');
    const t = withOutside(own, [
        { file: '/w/a.tsk', tree: first },
        { file: '/w/b.tsk', tree: second },
    ]);

    it("finds an id the file doesn't have in the files beside it, the file's own first, then the first file's", () => {
        expect(lookupId(t, 'a')).toBe(at(own, 'a'));
        expect(lookupId(t, 'dup')).toBe(at(own, 'dup'));
        expect(lookupId(t, 'b')).toBe(at(first, 'b'));
        expect(lookupId(t, 'c')).toBe(at(second, 'c'));
        expect(lookupId(t, 'zz')).toBeUndefined();
        expect(lookupId(own, 'b')).toBeUndefined();
    });

    it('knows which file each of their tasks is in, the ones without an id too', () => {
        expect(outsideFileOf(t, at(first, 'b'))).toBe('/w/a.tsk');
        expect(outsideFileOf(t, at(second, 'b'))).toBe('/w/b.tsk');
        expect(outsideFileOf(t, first.nodes[2] as TreeNode)).toBe('/w/a.tsk');
        expect(outsideFileOf(t, at(own, 'a'))).toBeUndefined();
    });

    it("leaves the file's own tree as it was", () => {
        expect(t.nodes).toBe(own.nodes);
        expect(t.byId).toBe(own.byId);
    });
});
