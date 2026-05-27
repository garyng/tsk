import { describe, expect, it } from 'vitest';
import {
    removeMetadataEntry,
    setMetadataEntry,
    swapMarker,
    toggleMetadataEntry,
    unwrapTask,
    type WrapOpts,
    wrapAsTask,
} from './toggle';

const FIXED_OPTS: WrapOpts = { id: 'abcd1234', timestamp: '2026-05-27T09:00:00+08:00' };

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

    it('wraps an empty line into an empty todo', () => {
        expect(wrapAsTask('', 'todo', FIXED_OPTS)).toBe(
            '- [ ] <!-- @id:abcd1234 @created:2026-05-27T09:00:00+08:00 -->',
        );
    });

    it('preserves leading indent (4 spaces)', () => {
        expect(wrapAsTask('    nested item', 'todo', FIXED_OPTS)).toBe(
            '    - [ ] nested item <!-- @id:abcd1234 @created:2026-05-27T09:00:00+08:00 -->',
        );
    });

    it('treats a whitespace-only line as an indented empty todo', () => {
        expect(wrapAsTask('      ', 'todo', FIXED_OPTS)).toBe(
            '      - [ ] <!-- @id:abcd1234 @created:2026-05-27T09:00:00+08:00 -->',
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
