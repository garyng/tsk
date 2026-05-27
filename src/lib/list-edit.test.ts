import { describe, expect, it } from 'vitest';
import {
    computeEnterEdit,
    computeShiftTabEdit,
    computeTabEdit,
    type EditorOpts,
} from './list-edit';
import type { ToggleDeps } from './toggle-mutators';

const SPACE_OPTS: EditorOpts = { insertSpaces: true, tabSize: 4 };
const TAB_OPTS: EditorOpts = { insertSpaces: false, tabSize: 4 };

const FIXED_DEPS: ToggleDeps = {
    generateId: () => 'newid',
    now: () => '2026-05-27T10:00:00+08:00',
};
const NEW_META = '<!-- @id:newid @created:2026-05-27T10:00:00+08:00 -->';

describe('computeEnterEdit', () => {
    it('returns noop on a non-task line', () => {
        expect(computeEnterEdit('plain text', 0, SPACE_OPTS, FIXED_DEPS)).toEqual({
            kind: 'noop',
        });
    });

    it('returns noop when cursor is before the marker prefix end', () => {
        // `- [ ] thing` has prefixEnd=6 (after `- [ ] `). Col 3 is inside `[ ]`.
        expect(computeEnterEdit('- [ ] thing', 3, SPACE_OPTS, FIXED_DEPS)).toEqual({
            kind: 'noop',
        });
    });

    it('removes an empty task at column 0', () => {
        // `- [ ] ` is an empty task (content === '').
        expect(computeEnterEdit('- [ ] ', 6, SPACE_OPTS, FIXED_DEPS)).toEqual({
            kind: 'replace-line',
            text: '',
            cursorCol: 0,
        });
    });

    it('removes an empty task at column 0 with metadata (metadata is dropped)', () => {
        expect(computeEnterEdit('- [ ] <!-- @id:x -->', 6, SPACE_OPTS, FIXED_DEPS)).toEqual({
            kind: 'replace-line',
            text: '',
            cursorCol: 0,
        });
    });

    it('outdents an empty task at indent (4 spaces → 0)', () => {
        // raw = `    - [ ] `, cursor at end (col 10).
        expect(computeEnterEdit('    - [ ] ', 10, SPACE_OPTS, FIXED_DEPS)).toEqual({
            kind: 'replace-line',
            text: '- [ ] ',
            cursorCol: 6,
        });
    });

    it('outdents an empty task indented with a tab (1 tab → 0)', () => {
        expect(computeEnterEdit('\t- [ ] ', 7, TAB_OPTS, FIXED_DEPS)).toEqual({
            kind: 'replace-line',
            text: '- [ ] ',
            cursorCol: 6,
        });
    });

    it('creates an empty continuation when cursor is at end of content (no metadata)', () => {
        // `- [ ] foo`, cursor at col 9 (end of line). content="foo", contentEnd=9.
        // Continuation line uses TWO spaces between marker and metadata so the
        // cursor lands between them — first keystroke produces well-spaced output.
        expect(computeEnterEdit('- [ ] foo', 9, SPACE_OPTS, FIXED_DEPS)).toEqual({
            kind: 'split-line',
            firstText: '- [ ] foo',
            secondText: `- [ ]  ${NEW_META}`,
            cursorCol: 6,
        });
    });

    it('creates an empty continuation when cursor is at the space before metadata', () => {
        // `- [ ] foo <!-- @id:x -->`. Cursor at col 9 = the space between `foo` and `<--`.
        // contentEnd = 9 (last non-whitespace before metadata).
        expect(computeEnterEdit('- [ ] foo <!-- @id:x -->', 9, SPACE_OPTS, FIXED_DEPS)).toEqual({
            kind: 'split-line',
            firstText: '- [ ] foo <!-- @id:x -->',
            secondText: `- [ ]  ${NEW_META}`,
            cursorCol: 6,
        });
    });

    it('creates an empty continuation when cursor is at end of line past metadata', () => {
        const line = '- [ ] foo <!-- @id:x -->';
        expect(computeEnterEdit(line, line.length, SPACE_OPTS, FIXED_DEPS)).toEqual({
            kind: 'split-line',
            firstText: line,
            secondText: `- [ ]  ${NEW_META}`,
            cursorCol: 6,
        });
    });

    it('returns noop when cursor is strictly inside the metadata block', () => {
        // Cursor at col 15 lands inside `@id:x`.
        expect(computeEnterEdit('- [ ] foo <!-- @id:x -->', 15, SPACE_OPTS, FIXED_DEPS)).toEqual({
            kind: 'noop',
        });
    });

    it('splits mid-content with no metadata', () => {
        // `- [ ] foo bar`, cursor at col 10 (after "foo ").
        expect(computeEnterEdit('- [ ] foo bar', 10, SPACE_OPTS, FIXED_DEPS)).toEqual({
            kind: 'split-line',
            firstText: '- [ ] foo',
            secondText: `- [ ] bar ${NEW_META}`,
            cursorCol: 6,
        });
    });

    it('splits mid-content with metadata pinned to the first line', () => {
        // `- [ ] foo bar <!-- @id:x -->`, cursor at col 10 (after "foo ").
        expect(
            computeEnterEdit('- [ ] foo bar <!-- @id:x -->', 10, SPACE_OPTS, FIXED_DEPS),
        ).toEqual({
            kind: 'split-line',
            firstText: '- [ ] foo <!-- @id:x -->',
            secondText: `- [ ] bar ${NEW_META}`,
            cursorCol: 6,
        });
    });

    it('continues an indented task at the same indent', () => {
        // `    - [ ] foo`, cursor at col 13 (end). continuationPrefix length = 9.
        expect(computeEnterEdit('    - [ ] foo', 13, SPACE_OPTS, FIXED_DEPS)).toEqual({
            kind: 'split-line',
            firstText: '    - [ ] foo',
            secondText: `    - [ ]  ${NEW_META}`,
            cursorCol: 10,
        });
    });

    it('resets the continuation marker to [ ] even when original is [x]', () => {
        expect(computeEnterEdit('- [x] done', 10, SPACE_OPTS, FIXED_DEPS)).toEqual({
            kind: 'split-line',
            firstText: '- [x] done',
            secondText: `- [ ]  ${NEW_META}`,
            cursorCol: 6,
        });
    });
});

describe('computeTabEdit', () => {
    it('returns noop on a non-task line', () => {
        expect(computeTabEdit('plain text', 0, SPACE_OPTS)).toEqual({ kind: 'noop' });
    });

    it('returns noop on a non-empty task (default Tab applies)', () => {
        expect(computeTabEdit('- [ ] foo', 6, SPACE_OPTS)).toEqual({ kind: 'noop' });
    });

    it('indents an empty task with insertSpaces (4 spaces prepended)', () => {
        expect(computeTabEdit('- [ ] ', 6, SPACE_OPTS)).toEqual({
            kind: 'replace-line',
            text: '    - [ ] ',
            cursorCol: 10,
        });
    });

    it('indents an empty task with tabs (one tab prepended)', () => {
        expect(computeTabEdit('- [ ] ', 6, TAB_OPTS)).toEqual({
            kind: 'replace-line',
            text: '\t- [ ] ',
            cursorCol: 7,
        });
    });

    it('indents an empty task with metadata, preserving the metadata', () => {
        expect(computeTabEdit('- [ ] <!-- @id:x -->', 6, SPACE_OPTS)).toEqual({
            kind: 'replace-line',
            text: '    - [ ] <!-- @id:x -->',
            cursorCol: 10,
        });
    });
});

describe('computeShiftTabEdit', () => {
    it('returns noop on a non-task line', () => {
        expect(computeShiftTabEdit('plain text', 0, SPACE_OPTS)).toEqual({ kind: 'noop' });
    });

    it('returns noop on a task at column 0 (no indent to remove)', () => {
        expect(computeShiftTabEdit('- [ ] foo', 6, SPACE_OPTS)).toEqual({ kind: 'noop' });
    });

    it('dedents an indented task by tabSize spaces', () => {
        expect(computeShiftTabEdit('    - [ ] foo', 10, SPACE_OPTS)).toEqual({
            kind: 'replace-line',
            text: '- [ ] foo',
            cursorCol: 6,
        });
    });

    it('dedents a tab-indented task by one tab', () => {
        expect(computeShiftTabEdit('\t- [ ] foo', 7, TAB_OPTS)).toEqual({
            kind: 'replace-line',
            text: '- [ ] foo',
            cursorCol: 6,
        });
    });

    it('dedents a non-empty task (Shift+Tab works on any task with indent)', () => {
        expect(computeShiftTabEdit('    - [x] done <!-- @id:x -->', 14, SPACE_OPTS)).toEqual({
            kind: 'replace-line',
            text: '- [x] done <!-- @id:x -->',
            cursorCol: 10,
        });
    });
});
