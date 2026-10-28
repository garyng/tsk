import { describe, expect, it } from 'vitest';
import { cursorRow, ESC_AGAIN_MS, noteEscape, noteRows, verticalMove } from './tui-note';

describe('noteEscape', () => {
    it('cancels an empty note', () => {
        expect(noteEscape('', undefined, 0)).toBe('cancel');
        expect(noteEscape('', 100, 200)).toBe('cancel');
    });
    it('arms on the first Esc, clears on a second within the window, arms again after it', () => {
        expect(noteEscape('fix it', undefined, 1000)).toBe('arm');
        expect(noteEscape('fix it', 1000, 1000 + ESC_AGAIN_MS)).toBe('clear');
        expect(noteEscape('fix it', 1000, 1001 + ESC_AGAIN_MS)).toBe('arm');
    });
});

/** The rows as their text, `|` between them. */
const show = (lines: string[], first: number, rest: number) =>
    noteRows(lines, first, rest)
        .map((r) => (lines[r.line] ?? '').slice(r.start, r.end))
        .join('|');

describe('noteRows', () => {
    it('keeps a line that fits on one row, and an empty line as an empty row', () => {
        expect(show(['fix it', ''], 20, 20)).toBe('fix it|');
    });
    it('wraps at a space, the space staying at the end of its row', () => {
        expect(show(['the quick brown fox'], 10, 10)).toBe('the quick |brown fox');
    });
    it('makes the first row narrower than the rest', () => {
        expect(show(['aaa bbb ccc ddd'], 4, 8)).toBe('aaa |bbb ccc |ddd');
    });
    it('breaks a word longer than a row mid-word', () => {
        expect(show(['abcdefghij'], 4, 4)).toBe('abcd|efgh|ij');
    });
    it('ends a row on a space that would overflow it', () => {
        expect(show(['abcd efgh'], 4, 4)).toBe('abcd |efgh');
    });
    it('counts wide characters as two columns', () => {
        expect(show(['日本語のメモ'], 6, 6)).toBe('日本語|のメモ');
    });
    it('starts each line on a row of its own', () => {
        expect(show(['one', 'two three four'], 20, 6)).toBe('one|two |three |four');
    });
});

describe('cursorRow', () => {
    const lines = ['the quick brown', 'x'];
    const rows = noteRows(lines, 10, 10); // 'the quick ' | 'brown' | 'x'
    it("shows a cursor at a wrap at the next row's start", () => {
        expect(cursorRow(rows, 0, 9)).toBe(0);
        expect(cursorRow(rows, 0, 10)).toBe(1);
        expect(cursorRow(rows, 0, 15)).toBe(1);
        expect(cursorRow(rows, 1, 0)).toBe(2);
        expect(cursorRow(rows, 1, 1)).toBe(2);
    });
});

describe('verticalMove', () => {
    const lines = ['the quick brown', 'xy'];
    const rows = noteRows(lines, 10, 10); // 'the quick ' | 'brown' | 'xy'
    const flat = () => 0;
    it('moves within a wrapped line, keeping the column', () => {
        expect(verticalMove(rows, lines, 0, 13, -1, flat)).toEqual({ line: 0, cursor: 3 });
        expect(verticalMove(rows, lines, 0, 2, 1, flat)).toEqual({ line: 0, cursor: 12 });
    });
    it("stops short of a wrapped row's end, which is the next row's start", () => {
        expect(verticalMove(rows, lines, 0, 15, -1, flat)).toEqual({ line: 0, cursor: 5 });
        expect(verticalMove(rows, lines, 0, 8, 1, flat)).toEqual({ line: 0, cursor: 15 });
    });
    it('moves to the next line as far as it goes, and not past the first or last row', () => {
        expect(verticalMove(rows, lines, 0, 14, 1, flat)).toEqual({ line: 1, cursor: 2 });
        expect(verticalMove(rows, lines, 0, 3, -1, flat)).toBeUndefined();
        expect(verticalMove(rows, lines, 1, 0, 1, flat)).toBeUndefined();
    });
    it('counts where each row starts on screen', () => {
        // The first row starts after a 4-column prompt, the rest at column 1.
        const indent = (r: number) => (r === 0 ? 4 : 1);
        expect(verticalMove(rows, lines, 0, 2, 1, indent)).toEqual({ line: 0, cursor: 15 });
        expect(verticalMove(rows, lines, 0, 12, -1, indent)).toEqual({ line: 0, cursor: 0 });
    });
});
