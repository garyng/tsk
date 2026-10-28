import { describe, expect, it } from 'vitest';
import { filterTerms, idMatchLength, inputWindow, termMatcher, termRanges } from './tui-filter';

describe('filterTerms', () => {
    it('splits at spaces, dropping empty terms', () => {
        expect(filterTerms('  fold  tree ')).toEqual(['fold', 'tree']);
        expect(filterTerms('   ')).toEqual([]);
    });
});

describe('termMatcher', () => {
    const matches = (query: string, text: string, id?: string) =>
        termMatcher(filterTerms(query))(text, id);

    it('needs every term in the text, ignoring case, anywhere in it', () => {
        expect(matches('TUI fold', 'Folding in the tui')).toBe(true);
        expect(matches('tui search', 'Folding in the tui')).toBe(false);
    });

    it('takes a term that starts the task’s @id, whatever its case, but not one inside it', () => {
        expect(matches('9SKGZ2QT', 'Folding', '9skgz2qt')).toBe(true);
        expect(matches('9skg', 'Folding', '9skgz2qt')).toBe(true);
        expect(matches('skgz', 'Folding', '9skgz2qt')).toBe(false);
        expect(matches('9skg fold', 'Folding', '9skgz2qt')).toBe(true);
        expect(matches('9skg', 'Folding')).toBe(false);
    });

    it('reads a term as text, not a pattern', () => {
        expect(matches('a.c', 'abc')).toBe(false);
        expect(matches('[x]', 'marker [x] here')).toBe(true);
    });
});

describe('idMatchLength', () => {
    it('is the longest term found only at the start of the id', () => {
        expect(idMatchLength('Folding', '9skgz2qt', ['9s', '9SKG'])).toBe(4);
    });

    it('is 0 when the text holds every term the id does', () => {
        expect(idMatchLength('9 skeins', '9skgz2qt', ['9', 's'])).toBe(0);
        expect(idMatchLength('Folding', '9skgz2qt', ['fold'])).toBe(0);
        expect(idMatchLength('Folding', undefined, ['9s'])).toBe(0);
    });
});

describe('termRanges', () => {
    it('finds every occurrence of each term, ignoring case, in order', () => {
        expect(termRanges('Tree trees', ['tree'])).toEqual([
            { start: 0, end: 4 },
            { start: 5, end: 9 },
        ]);
    });

    it('merges the ranges of terms that overlap or touch', () => {
        expect(termRanges('folding', ['fold', 'ding', 'old'])).toEqual([{ start: 0, end: 7 }]);
    });

    it('counts offsets in the text as written, where lower-casing would lengthen it', () => {
        // 'İ' lower-cases to two code units; the offsets must not shift.
        expect(termRanges('İx fold', ['fold'])).toEqual([{ start: 3, end: 7 }]);
    });
});

describe('inputWindow', () => {
    it('shows it all when it fits with a column for the cursor', () => {
        expect(inputWindow('abc', 3, 4)).toEqual({ start: 0, end: 3 });
    });

    it('scrolls just far enough to keep a cursor at the end in view', () => {
        expect(inputWindow('abcdef', 6, 4)).toEqual({ start: 3, end: 6 });
    });

    it('keeps the start while the cursor is in view there, cutting the end', () => {
        expect(inputWindow('abcdef', 1, 4)).toEqual({ start: 0, end: 4 });
    });

    it('counts wide characters by their columns', () => {
        // Each 日 is two columns: two and the cursor fill five.
        expect(inputWindow('日本語', 3, 5)).toEqual({ start: 1, end: 3 });
    });
});
