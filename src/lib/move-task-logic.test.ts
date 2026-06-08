import { describe, expect, it } from 'vitest';
import { buildMoveStub, computeTaskBlockRange, dedentBlock } from './move-task-logic';
import { parseLine } from './parser';

describe('computeTaskBlockRange', () => {
    it('a task with no children is its own block', () => {
        const lines = ['- [ ] solo <!-- @id:s -->', '- [ ] next <!-- @id:n -->'];
        expect(computeTaskBlockRange(lines, 0, 2)).toEqual({ start: 0, end: 0 });
    });

    it('includes the nested sub-items and stops at a sibling', () => {
        const lines = [
            '- [ ] parent <!-- @id:p -->', // 0
            '  - [ ] child a <!-- @id:a -->', // 1 (col 2)
            '    - [ ] grandchild <!-- @id:g -->', // 2 (col 4)
            '  - [ ] child b <!-- @id:b -->', // 3 (col 2)
            '- [ ] sibling <!-- @id:s -->', // 4 (col 0) ends it
        ];
        expect(computeTaskBlockRange(lines, 0, 2)).toEqual({ start: 0, end: 3 });
        // From child a: grandchild is deeper, child b is a sibling (same col).
        expect(computeTaskBlockRange(lines, 1, 2)).toEqual({ start: 1, end: 2 });
    });

    it('keeps interior blank lines but excludes trailing ones', () => {
        const lines = [
            '- [ ] parent', // 0
            '  notes line', // 1 (col 2, non-task continuation)
            '', // 2 interior blank
            '  more notes', // 3 (col 2)
            '', // 4 trailing blank — excluded
        ];
        expect(computeTaskBlockRange(lines, 0, 2)).toEqual({ start: 0, end: 3 });
    });

    it('runs to EOF when the block has no following sibling', () => {
        const lines = ['- [ ] parent', '  - [ ] child'];
        expect(computeTaskBlockRange(lines, 0, 2)).toEqual({ start: 0, end: 1 });
    });

    it('compares by expanded column for tab indentation', () => {
        const lines = ['- [ ] parent', '\t- [ ] child']; // tab → col 4 at tabSize 4
        expect(computeTaskBlockRange(lines, 0, 4)).toEqual({ start: 0, end: 1 });
    });

    it('treats a visually-shallower line as a sibling under mixed tab/space', () => {
        // Parent indented one tab (col 4); the next line is two spaces (col 2) —
        // visually shallower, so NOT a child (a raw char-count compare would wrongly
        // include it: 2 chars > 1 char).
        const lines = ['\t- [ ] parent <!-- @id:p -->', '  - [ ] not-a-child <!-- @id:n -->'];
        expect(computeTaskBlockRange(lines, 0, 4)).toEqual({ start: 0, end: 0 });
    });
});

describe('dedentBlock', () => {
    it('strips the parent prefix, rebasing children and clearing blanks', () => {
        const block = ['  - [ ] parent', '    - [ ] child', '', '  notes'];
        expect(dedentBlock(block, '  ')).toEqual(['- [ ] parent', '  - [ ] child', '', 'notes']);
    });

    it('is a no-op when the parent is already at column 0', () => {
        const block = ['- [ ] parent', '  - [ ] child'];
        expect(dedentBlock(block, '')).toEqual(block);
    });

    it('rebases tab-indented children by the literal tab prefix', () => {
        const block = ['\t- [ ] parent', '\t\t- [ ] child'];
        expect(dedentBlock(block, '\t')).toEqual(['- [ ] parent', '\t- [ ] child']);
    });
});

describe('buildMoveStub', () => {
    const stubOf = (line: string, id = 'NEW123', now = '2026-06-08T10:00:00+00:00') => {
        const task = parseLine(line);
        if (!task) throw new Error(`not a task: ${line}`);
        return buildMoveStub(task, id, now);
    };

    it('builds a [>] stub with a fresh id, @movedTo, and @moved; strips tags + extra metadata', () => {
        const stub = stubOf('- [/] do thing #proj <!-- @id:X @created:2026-01-01 @priority:1 -->');
        expect(stub).toBe(
            '- [>] do thing <!-- @id:NEW123 @movedTo:X @moved:2026-06-08T10:00:00+00:00 -->',
        );
    });

    it('preserves the original bullet and indentation', () => {
        expect(stubOf('  * [x] done <!-- @id:Y -->', 'N', 'T')).toBe(
            '  * [>] done <!-- @id:N @movedTo:Y @moved:T -->',
        );
    });

    it('omits the content gap when the content was only a tag', () => {
        expect(stubOf('- [ ] #onlytag <!-- @id:Z -->', 'N', 'T')).toBe(
            '- [>] <!-- @id:N @movedTo:Z @moved:T -->',
        );
    });

    it('throws when the task has no @id to point @movedTo at', () => {
        const task = parseLine('- [ ] no id here');
        if (!task) throw new Error('expected a task');
        expect(() => buildMoveStub(task, 'N', 'T')).toThrow(/no @id/);
    });
});
