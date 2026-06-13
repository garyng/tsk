import { describe, expect, it } from 'vitest';
import {
    buildAppendText,
    buildMoveStub,
    computeBlockDeletion,
    computeTaskBlockRange,
    dedentBlock,
} from './move-task-logic';
import { parseLine } from './parser';

describe('computeBlockDeletion', () => {
    it('a mid-file block consumes the newline AFTER it', () => {
        // file: A,B,C,D,E (lineCount 5); delete the B-C block (1..2).
        expect(computeBlockDeletion(5, 1, 2, 0, 0)).toEqual({
            startLine: 1,
            startChar: 0,
            endLine: 3,
            endChar: 0,
        });
    });

    it('a single-line block mid-file consumes its trailing newline', () => {
        expect(computeBlockDeletion(5, 2, 2, 0, 0)).toEqual({
            startLine: 2,
            startChar: 0,
            endLine: 3,
            endChar: 0,
        });
    });

    it('a block at EOF consumes the newline BEFORE it (prevLineLen)', () => {
        // file ends at line 3 (lineCount 4); delete block 2..3, line 1 is 7 chars.
        expect(computeBlockDeletion(4, 2, 3, 7, 12)).toEqual({
            startLine: 1,
            startChar: 7,
            endLine: 3,
            endChar: 12,
        });
    });

    it('a single-line block at EOF consumes the preceding newline', () => {
        expect(computeBlockDeletion(4, 3, 3, 5, 9)).toEqual({
            startLine: 2,
            startChar: 5,
            endLine: 3,
            endChar: 9,
        });
    });

    it('a whole-file block empties the document (no preceding newline to take)', () => {
        expect(computeBlockDeletion(3, 0, 2, 0, 4)).toEqual({
            startLine: 0,
            startChar: 0,
            endLine: 2,
            endChar: 4,
        });
    });

    it('a block ending one line before a file-final blank line stays in the mid-file case', () => {
        // file: A, task, "" (trailing blank, lineCount 3) → end=1 < 2 → mid-file.
        expect(computeBlockDeletion(3, 1, 1, 0, 0)).toEqual({
            startLine: 1,
            startChar: 0,
            endLine: 2,
            endChar: 0,
        });
    });
});

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

describe('buildAppendText', () => {
    it('an empty target gets just the block + trailing newline', () => {
        expect(buildAppendText('', ['- [ ] a', '- [ ] b'], '\n')).toBe('- [ ] a\n- [ ] b\n');
        expect(buildAppendText('   \n', ['- [ ] a'], '\n')).toBe('- [ ] a\n');
    });

    it('separates from a newline-terminated file with one blank line', () => {
        expect(buildAppendText('# notes\n', ['- [ ] a'], '\n')).toBe('\n- [ ] a\n');
    });

    it('separates from a file with no trailing newline using two', () => {
        expect(buildAppendText('# notes', ['- [ ] a'], '\n')).toBe('\n\n- [ ] a\n');
    });

    it('honors CRLF', () => {
        expect(buildAppendText('# notes\r\n', ['- [ ] a'], '\r\n')).toBe('\r\n- [ ] a\r\n');
    });
});
