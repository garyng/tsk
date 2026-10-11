import { describe, expect, it } from 'vitest';
import { computeFoldRanges } from './folding';

const DIV = (label: string): string => `-${label}${'-'.repeat(20)}`;

/** Sorted + compacted, so assertions read as `[start, end, kind]` triples. */
const folds = (lines: readonly string[]): [number, number, string][] =>
    computeFoldRanges(lines)
        .map((r) => [r.start, r.end, r.kind] as [number, number, string])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

describe('computeFoldRanges — indentation', () => {
    it('folds a parent over its children', () => {
        expect(
            folds(['- [ ] parent', '    - [ ] child', '    - [ ] child2', '- [ ] sibling']),
        ).toEqual([[0, 2, 'indentation']]);
    });

    it('nests', () => {
        expect(folds(['- [ ] a', '    - [ ] b', '        - [ ] c', '- [ ] d'])).toEqual([
            [0, 2, 'indentation'],
            [1, 2, 'indentation'],
        ]);
    });

    it('a childless line folds nothing', () => {
        expect(folds(['- [ ] a', '- [ ] b'])).toEqual([]);
    });

    it('blank lines are transparent, not block terminators', () => {
        expect(folds(['- [ ] a', '    - [ ] b', '', '    - [ ] c', '- [ ] d'])).toEqual([
            [0, 3, 'indentation'],
        ]);
    });

    it('trailing blanks are excluded from the fold', () => {
        expect(folds(['- [ ] a', '    - [ ] b', '', ''])).toEqual([[0, 1, 'indentation']]);
    });

    it('dedents close the block', () => {
        expect(folds(['- [ ] a', '    - [ ] b', '- [ ] c', '    - [ ] d'])).toEqual([
            [0, 1, 'indentation'],
            [2, 3, 'indentation'],
        ]);
    });
});

describe('computeFoldRanges — divider sections', () => {
    it('a divider folds down to the line before the next one', () => {
        expect(folds([DIV('todo'), '- [ ] a', '- [ ] b', DIV('focus'), '- [ ] c'])).toEqual([
            [0, 2, 'region'],
            [3, 4, 'region'],
        ]);
    });

    it('content above the first divider is not folded by it', () => {
        expect(folds(['intro', DIV('todo'), '- [ ] a'])).toEqual([[1, 2, 'region']]);
    });

    it('adjacent dividers yield no empty region', () => {
        // Two dividers on consecutive lines — common in hand-maintained files.
        expect(folds([DIV('focus'), DIV('inbox'), '- [ ] a'])).toEqual([[1, 2, 'region']]);
    });

    it('a trailing blank line is not part of the section', () => {
        expect(folds([DIV('todo'), '- [ ] a', '', ''])).toEqual([[0, 1, 'region']]);
    });

    it('a divider does not also open an indentation block', () => {
        // Otherwise the same span would fold twice, once per kind.
        const result = folds([DIV('todo'), '- [ ] a', '- [ ] b']);
        expect(result).toEqual([[0, 2, 'region']]);
    });
});

describe('computeFoldRanges — both together', () => {
    it('reproduces the probe case that motivated this module', () => {
        // Without indentation ranges here, registering the provider would have
        // silently dropped the task-block fold (see the module docstring).
        expect(
            folds([
                '- [ ] parent',
                '    - [ ] child',
                '    - [ ] child2',
                DIV('todo'),
                '- [ ] after',
                '- [ ] after2',
                '',
            ]),
        ).toEqual([
            [0, 2, 'indentation'],
            [3, 5, 'region'],
        ]);
    });

    it('an indentation block inside a section nests under it', () => {
        expect(folds([DIV('todo'), '- [ ] a', '    - [ ] b', '- [ ] c'])).toEqual([
            [0, 3, 'region'],
            [1, 2, 'indentation'],
        ]);
    });

    it('an empty document folds nothing', () => {
        expect(folds([])).toEqual([]);
        expect(folds([''])).toEqual([]);
    });
});
