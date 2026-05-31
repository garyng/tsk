import { describe, expect, it } from 'vitest';
import {
    contentCursorCol,
    promoteMissingMetadata,
    refreshTaskIdentity,
    removeMetadataEntry,
    setMetadataEntry,
    swapMarker,
    taskContentRange,
    toggleMetadataEntry,
    unwrapTask,
    type WrapOpts,
    wrapAsTask,
} from './toggle';

const FIXED_OPTS: WrapOpts = { id: 'abcd1234', timestamp: '2026-05-27T09:00:00+08:00' };
const FIXED_DEPS = {
    generateId: () => 'newid',
    now: () => '2026-05-27T10:00:00+08:00',
};

describe('swapMarker', () => {
    it('swaps an empty marker into completed', () => {
        expect(swapMarker('- [ ] do it', 'completed')).toBe('- [x] do it');
    });

    it('swaps completed back to todo, preserving metadata', () => {
        expect(swapMarker('- [x] done <!-- @id:abc -->', 'todo')).toBe(
            '- [ ] done <!-- @id:abc -->',
        );
    });

    it('preserves indent on a nested task', () => {
        expect(swapMarker('    - [ ] nested', 'inprogress')).toBe('    - [/] nested');
    });

    it('preserves alternate bullets (* and +)', () => {
        expect(swapMarker('* [ ] starred', 'completed')).toBe('* [x] starred');
        expect(swapMarker('+ [ ] plused', 'cancelled')).toBe('+ [!] plused');
    });

    it('passes a non-task line through unchanged', () => {
        expect(swapMarker('just a paragraph', 'completed')).toBe('just a paragraph');
    });

    it('canonicalizes [X] to [x] when swapping back to completed', () => {
        // Parser tolerates [X]; we always write [x] on swap.
        expect(swapMarker('- [X] done', 'completed')).toBe('- [x] done');
    });
});

describe('wrapAsTask', () => {
    it('wraps a plain line into a todo with metadata', () => {
        expect(wrapAsTask('write the spec', 'todo', FIXED_OPTS)).toBe(
            '- [ ] write the spec <!-- @id:abcd1234 @created:2026-05-27T09:00:00+08:00 -->',
        );
    });

    it('wraps an empty line into an empty todo with the cursor-spacer (two spaces before metadata)', () => {
        expect(wrapAsTask('', 'todo', FIXED_OPTS)).toBe(
            '- [ ]  <!-- @id:abcd1234 @created:2026-05-27T09:00:00+08:00 -->',
        );
    });

    it('preserves leading indent (4 spaces)', () => {
        expect(wrapAsTask('    nested item', 'todo', FIXED_OPTS)).toBe(
            '    - [ ] nested item <!-- @id:abcd1234 @created:2026-05-27T09:00:00+08:00 -->',
        );
    });

    it('treats a whitespace-only line as an indented empty todo', () => {
        expect(wrapAsTask('      ', 'todo', FIXED_OPTS)).toBe(
            '      - [ ]  <!-- @id:abcd1234 @created:2026-05-27T09:00:00+08:00 -->',
        );
    });

    it('wraps with the notes marker when requested', () => {
        expect(wrapAsTask('an aside', 'notes', FIXED_OPTS)).toBe(
            '- [n] an aside <!-- @id:abcd1234 @created:2026-05-27T09:00:00+08:00 -->',
        );
    });

    it('passes an existing task through unchanged', () => {
        const existing = '- [/] in flight <!-- @id:zz -->';
        expect(wrapAsTask(existing, 'todo', FIXED_OPTS)).toBe(existing);
    });

    it('wraps a bare bullet by its content, not doubling the marker', () => {
        expect(wrapAsTask('- milk', 'todo', FIXED_OPTS)).toBe(
            '- [ ] milk <!-- @id:abcd1234 @created:2026-05-27T09:00:00+08:00 -->',
        );
    });

    it('canonicalizes * and + bullets to - when wrapping', () => {
        expect(wrapAsTask('* milk', 'todo', FIXED_OPTS)).toBe(
            '- [ ] milk <!-- @id:abcd1234 @created:2026-05-27T09:00:00+08:00 -->',
        );
        expect(wrapAsTask('+ milk', 'todo', FIXED_OPTS)).toBe(
            '- [ ] milk <!-- @id:abcd1234 @created:2026-05-27T09:00:00+08:00 -->',
        );
    });

    it('preserves indent when wrapping an indented bare bullet', () => {
        expect(wrapAsTask('    - nested note', 'todo', FIXED_OPTS)).toBe(
            '    - [ ] nested note <!-- @id:abcd1234 @created:2026-05-27T09:00:00+08:00 -->',
        );
    });

    it('wraps an empty bare bullet into an empty todo', () => {
        expect(wrapAsTask('- ', 'todo', FIXED_OPTS)).toBe(
            '- [ ]  <!-- @id:abcd1234 @created:2026-05-27T09:00:00+08:00 -->',
        );
    });
});

describe('contentCursorCol', () => {
    it('returns the spacer column for an empty wrapped task', () => {
        expect(contentCursorCol('- [ ]  <!-- @id:x -->')).toBe(6);
    });

    it('returns the end of content (before the metadata) for a content task', () => {
        // `- [ ] buy milk <!-- … -->` — cursor right after "milk".
        expect(contentCursorCol('- [ ] buy milk <!-- @id:x -->')).toBe(14);
    });

    it('accounts for indent', () => {
        expect(contentCursorCol('    - [ ] foo <!-- @id:x -->')).toBe(13);
    });

    it('falls back to the trimmed line end when there is no metadata', () => {
        expect(contentCursorCol('- [ ] foo')).toBe(9);
    });

    it('returns null for a non-task line', () => {
        expect(contentCursorCol('plain text')).toBeNull();
    });
});

describe('taskContentRange', () => {
    it('spans the content of a task with trailing metadata', () => {
        expect(taskContentRange('- [ ] buy milk <!-- @id:x -->')).toEqual({ start: 6, end: 14 });
    });

    it('spans content with no metadata (trimmed to the last char)', () => {
        expect(taskContentRange('- [ ] buy milk')).toEqual({ start: 6, end: 14 });
    });

    it('returns a zero-width range at the content start for an empty task', () => {
        expect(taskContentRange('- [ ] <!-- @id:x -->')).toEqual({ start: 6, end: 6 });
    });

    it('accounts for indentation and a wider marker', () => {
        // 4 indent + "- " + "[/]" → bracket at col 6, content "do it" at 10..15
        expect(taskContentRange('    - [/] do it <!-- @id:x -->')).toEqual({ start: 10, end: 15 });
    });

    it('returns null for non-task lines', () => {
        expect(taskContentRange('- a bare bullet')).toBeNull();
        expect(taskContentRange('plain text')).toBeNull();
    });
});

describe('promoteMissingMetadata', () => {
    it('fills @id + @created on a markered task with no metadata', () => {
        expect(promoteMissingMetadata('- [ ] needs id', FIXED_DEPS)).toBe(
            '- [ ] needs id <!-- @id:newid @created:2026-05-27T10:00:00+08:00 -->',
        );
    });

    it('fills only @id when @created is already present', () => {
        expect(
            promoteMissingMetadata(
                '- [ ] partial <!-- @created:2026-01-01T00:00:00+08:00 -->',
                FIXED_DEPS,
            ),
        ).toBe('- [ ] partial <!-- @created:2026-01-01T00:00:00+08:00 @id:newid -->');
    });

    it('is marker-agnostic — works on completed tasks too', () => {
        // The code-action provider relies on this: a hand-typed `- [x] done`
        // without @id can be promoted in place without changing the marker.
        expect(promoteMissingMetadata('- [x] done', FIXED_DEPS)).toBe(
            '- [x] done <!-- @id:newid @created:2026-05-27T10:00:00+08:00 -->',
        );
    });

    it('returns null when the task already has @id (no work to do)', () => {
        expect(promoteMissingMetadata('- [ ] x <!-- @id:abc -->', FIXED_DEPS)).toBeNull();
    });

    it('returns null on a non-task line', () => {
        expect(promoteMissingMetadata('plain text', FIXED_DEPS)).toBeNull();
    });
});

describe('unwrapTask', () => {
    it('strips an empty todo back to an empty line', () => {
        expect(unwrapTask('- [ ] <!-- @id:x -->')).toBe('');
    });

    it('preserves indent when unwrapping', () => {
        expect(unwrapTask('    - [ ] <!-- @id:x -->')).toBe('    ');
    });

    it('refuses to drop a task with content', () => {
        const line = '- [ ] still doing this <!-- @id:x -->';
        expect(unwrapTask(line)).toBe(line);
    });

    it('passes a non-task line through unchanged', () => {
        expect(unwrapTask('just a paragraph')).toBe('just a paragraph');
    });
});

describe('setMetadataEntry', () => {
    it('adds a new key on a bare task line', () => {
        expect(setMetadataEntry('- [ ] do it', 'id', 'abc')).toBe('- [ ] do it <!-- @id:abc -->');
    });

    it('overwrites an existing key', () => {
        expect(setMetadataEntry('- [ ] x <!-- @priority:1 -->', 'priority', '2')).toBe(
            '- [ ] x <!-- @priority:2 -->',
        );
    });

    it('sets a flag-form entry (value null)', () => {
        expect(setMetadataEntry('- [ ] x', 'starred', null)).toBe('- [ ] x <!-- @starred -->');
    });

    it('passes a non-task line through unchanged', () => {
        expect(setMetadataEntry('not a task', 'id', 'abc')).toBe('not a task');
    });
});

describe('removeMetadataEntry', () => {
    it('removes an existing key', () => {
        expect(removeMetadataEntry('- [ ] x <!-- @priority:2 -->', 'priority')).toBe('- [ ] x');
    });

    it('preserves other metadata when removing one entry', () => {
        expect(removeMetadataEntry('- [ ] x <!-- @id:a @priority:2 -->', 'priority')).toBe(
            '- [ ] x <!-- @id:a -->',
        );
    });

    it('is a no-op when the key is absent', () => {
        const line = '- [ ] x <!-- @id:a -->';
        expect(removeMetadataEntry(line, 'priority')).toBe(line);
    });

    it('passes a non-task line through unchanged', () => {
        expect(removeMetadataEntry('not a task', 'id')).toBe('not a task');
    });
});

describe('toggleMetadataEntry', () => {
    it('adds when absent', () => {
        expect(toggleMetadataEntry('- [ ] x', 'priority', '1')).toBe(
            '- [ ] x <!-- @priority:1 -->',
        );
    });

    it('removes when present with matching value', () => {
        expect(toggleMetadataEntry('- [ ] x <!-- @priority:1 -->', 'priority', '1')).toBe(
            '- [ ] x',
        );
    });

    it('overwrites when present with a different value (mutual exclusion fallout)', () => {
        // Toggling P2 onto a P1 line writes @priority:2 in one step.
        expect(toggleMetadataEntry('- [ ] x <!-- @priority:1 -->', 'priority', '2')).toBe(
            '- [ ] x <!-- @priority:2 -->',
        );
    });

    it('handles flag-form (null value): add → remove → add', () => {
        const a = toggleMetadataEntry('- [ ] x', 'starred', null);
        expect(a).toBe('- [ ] x <!-- @starred -->');
        const b = toggleMetadataEntry(a, 'starred', null);
        expect(b).toBe('- [ ] x');
    });

    it('passes a non-task line through unchanged', () => {
        expect(toggleMetadataEntry('not a task', 'priority', '1')).toBe('not a task');
    });
});

describe('refreshTaskIdentity', () => {
    it('stamps a fresh @id and re-stamps @created', () => {
        expect(
            refreshTaskIdentity(
                '- [ ] foo <!-- @id:oldid @created:2026-01-01T00:00:00+08:00 -->',
                FIXED_DEPS,
            ),
        ).toBe('- [ ] foo <!-- @id:newid @created:2026-05-27T10:00:00+08:00 -->');
    });

    it('preserves lifecycle stamps (@started / @completed)', () => {
        expect(
            refreshTaskIdentity(
                '- [/] foo <!-- @id:oldid @created:2026-01-01T00:00:00+08:00 @started:2026-02-02T09:00:00+08:00 -->',
                FIXED_DEPS,
            ),
        ).toBe(
            '- [/] foo <!-- @id:newid @created:2026-05-27T10:00:00+08:00 @started:2026-02-02T09:00:00+08:00 -->',
        );
    });

    it('adds @created when the source task lacks one', () => {
        expect(refreshTaskIdentity('- [ ] foo <!-- @id:oldid -->', FIXED_DEPS)).toBe(
            '- [ ] foo <!-- @id:newid @created:2026-05-27T10:00:00+08:00 -->',
        );
    });

    it('passes non-task lines through unchanged', () => {
        expect(refreshTaskIdentity('- a bare bullet', FIXED_DEPS)).toBe('- a bare bullet');
        expect(refreshTaskIdentity('plain text', FIXED_DEPS)).toBe('plain text');
        expect(refreshTaskIdentity('', FIXED_DEPS)).toBe('');
    });
});
