import { describe, expect, it } from 'vitest';
import { dividerPlacement, dividerSections, formatDivider, matchDivider } from './divider';
import { parseBullet, parseLine } from './parser';

/** Dividers as they're written by hand in practice — ~100 columns wide. */
const TODO = `-todo${'-'.repeat(96)}`;
const DIV_TODO = TODO;
const FOCUS = `-focus${'-'.repeat(96)}`;

describe('matchDivider', () => {
    it('matches the real dividers and locates the dash run', () => {
        const divider = matchDivider(TODO);
        expect(divider).toMatchObject({ indent: '', label: 'todo', startCol: 0, dashStartCol: 5 });
        expect(TODO.slice(divider?.dashStartCol, divider?.endCol)).toBe('-'.repeat(96));
    });

    it('accepts any of the labels in use', () => {
        for (const [line, label] of [
            [TODO, 'todo'],
            [FOCUS, 'focus'],
            [`-inbox${'-'.repeat(96)}`, 'inbox'],
        ] as const) {
            expect(matchDivider(line)?.label).toBe(label);
        }
    });

    it('keeps indentation and reports it in the columns', () => {
        const divider = matchDivider('    -later-----');
        expect(divider).toMatchObject({ indent: '    ', label: 'later', startCol: 4 });
    });

    it('allows dashes and slashes inside the label, splitting at the trailing run', () => {
        expect(matchDivider('-p/tsk-----')?.label).toBe('p/tsk');
        expect(matchDivider('-a-b-----')?.label).toBe('a-b');
    });

    it('needs at least three trailing dashes', () => {
        expect(matchDivider('-todo---')).not.toBeNull();
        expect(matchDivider('-todo--')).toBeNull();
    });

    it('needs the dashes at the END', () => {
        expect(matchDivider('-todo---x')).toBeNull();
        expect(matchDivider('-todo--- trailing words')).toBeNull();
    });

    it('tolerates trailing whitespace and a stray CR', () => {
        expect(matchDivider('-todo---   ')?.label).toBe('todo');
        expect(matchDivider('-todo---\r')?.label).toBe('todo');
    });

    it('is not a markdown rule, a task, or a bullet', () => {
        expect(matchDivider('---')).toBeNull();
        expect(matchDivider('-----------')).toBeNull();
        expect(matchDivider('- [ ] a task')).toBeNull();
        expect(matchDivider('- a bare bullet')).toBeNull();
        expect(matchDivider('* starred---')).toBeNull(); // only `-` opens a divider
        expect(matchDivider('')).toBeNull();
    });

    /**
     * The collision guard, asserted against the real parsers rather than
     * argued in a comment: both need whitespace after the bullet char, which a
     * divider never has.
     */
    it('a divider parses as neither a task nor a bullet', () => {
        for (const line of [TODO, FOCUS, '    -later-----', '-a-b-----']) {
            expect(parseLine(line), `parseLine accepted ${line}`).toBeNull();
            expect(parseBullet(line), `parseBullet accepted ${line}`).toBeNull();
        }
    });
});

describe('formatDivider', () => {
    it('pads to the requested width', () => {
        const line = formatDivider('todo', 100);
        expect(line).toHaveLength(100);
        expect(line.startsWith('-todo-')).toBe(true);
    });

    it('round-trips through matchDivider', () => {
        for (const label of ['todo', 'focus', 'p/tsk', 'a-b', 'X']) {
            expect(matchDivider(formatDivider(label, 100))?.label).toBe(label);
        }
    });

    it('trims the label', () => {
        expect(matchDivider(formatDivider('  todo  ', 100))?.label).toBe('todo');
    });

    it('still emits a matchable line when the label overruns the width', () => {
        const long = 'a'.repeat(120);
        const line = formatDivider(long, 100);
        expect(line.length).toBeGreaterThan(100);
        expect(matchDivider(line)?.label).toBe(long);
    });
});

describe('dividerSections', () => {
    it('each divider owns up to the line before the next', () => {
        const lines = ['intro', TODO, 'a', 'b', FOCUS, 'c'];
        expect(dividerSections(lines)).toEqual([
            { line: 1, endLine: 3, label: 'todo' },
            { line: 4, endLine: 5, label: 'focus' },
        ]);
    });

    it('the last divider runs to end of file', () => {
        expect(dividerSections([TODO, 'a', 'b'])).toEqual([{ line: 0, endLine: 2, label: 'todo' }]);
    });

    it('adjacent dividers give the first a section of just itself', () => {
        // Seen in real files: two dividers on consecutive lines, like `-focus-` then `-inbox-`.
        expect(dividerSections([TODO, FOCUS, 'c'])).toEqual([
            { line: 0, endLine: 0, label: 'todo' },
            { line: 1, endLine: 2, label: 'focus' },
        ]);
    });

    it('content above the first divider belongs to no section', () => {
        expect(dividerSections(['a', 'b'])).toEqual([]);
    });
});

describe('dividerPlacement', () => {
    it('a blank line becomes the divider', () => {
        expect(dividerPlacement('')).toEqual({ mode: 'replace' });
        expect(dividerPlacement('   ')).toEqual({ mode: 'replace' });
    });

    it('an existing divider is edited in place, prefilled with its label', () => {
        expect(dividerPlacement(DIV_TODO)).toEqual({ mode: 'replace', existingLabel: 'todo' });
    });

    it('a line with content keeps it — the divider goes below', () => {
        expect(dividerPlacement('- [ ] a task')).toEqual({ mode: 'insertBelow' });
        expect(dividerPlacement('some prose')).toEqual({ mode: 'insertBelow' });
    });
});
