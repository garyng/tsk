import { describe, expect, it } from 'vitest';
import {
    type ToggleDeps,
    toggleCancelledMutator,
    toggleCompletedMutator,
    toggleInprogressMutator,
    toggleNoteMutator,
    toggleTodoMutator,
} from './toggle-mutators';

const FIXED_DEPS: ToggleDeps = {
    generateId: () => 'idfix123',
    now: () => '2026-05-27T10:00:00+08:00',
};

describe('toggleTodoMutator', () => {
    it('wraps a plain text line as a todo with @id + @created', () => {
        expect(toggleTodoMutator('write the spec', FIXED_DEPS)).toBe(
            '- [ ] write the spec <!-- @id:idfix123 @created:2026-05-27T10:00:00+08:00 -->',
        );
    });

    it('wraps an empty line as an empty todo', () => {
        expect(toggleTodoMutator('', FIXED_DEPS)).toBe(
            '- [ ] <!-- @id:idfix123 @created:2026-05-27T10:00:00+08:00 -->',
        );
    });

    it('unwraps an empty todo back to its indent', () => {
        expect(toggleTodoMutator('- [ ] <!-- @id:x -->', FIXED_DEPS)).toBe('');
        expect(toggleTodoMutator('    - [ ] <!-- @id:x -->', FIXED_DEPS)).toBe('    ');
    });

    it('no-ops on a todo that already has content', () => {
        const line = '- [ ] still doing this <!-- @id:x -->';
        expect(toggleTodoMutator(line, FIXED_DEPS)).toBe(line);
    });

    it('no-ops on a non-todo task (use the dedicated toggle to swap markers)', () => {
        const line = '- [x] done <!-- @id:x -->';
        expect(toggleTodoMutator(line, FIXED_DEPS)).toBe(line);
    });
});

describe('toggleNoteMutator', () => {
    it('wraps as a note marker, not a todo', () => {
        expect(toggleNoteMutator('aside', FIXED_DEPS)).toBe(
            '- [n] aside <!-- @id:idfix123 @created:2026-05-27T10:00:00+08:00 -->',
        );
    });

    it('unwraps an empty note', () => {
        expect(toggleNoteMutator('- [n] <!-- @id:x -->', FIXED_DEPS)).toBe('');
    });

    it('no-ops on a different marker (so toggleNote stays creation-scoped)', () => {
        const line = '- [ ] not a note';
        expect(toggleNoteMutator(line, FIXED_DEPS)).toBe(line);
    });
});

describe('toggleInprogressMutator', () => {
    it('flips todo to in-progress and adds @started', () => {
        expect(toggleInprogressMutator('- [ ] thing', FIXED_DEPS)).toBe(
            '- [/] thing <!-- @started:2026-05-27T10:00:00+08:00 -->',
        );
    });

    it('flips in-progress back to todo and removes @started', () => {
        expect(
            toggleInprogressMutator(
                '- [/] thing <!-- @started:2026-05-25T09:00:00+08:00 -->',
                FIXED_DEPS,
            ),
        ).toBe('- [ ] thing');
    });

    it('swaps a completed task to in-progress, preserving prior @completed', () => {
        // Pre-existing metadata from prior toggles is left alone; the user can
        // clear @completed explicitly via toggleCompleted if they want to.
        expect(
            toggleInprogressMutator(
                '- [x] thing <!-- @completed:2026-05-25T10:00:00+08:00 -->',
                FIXED_DEPS,
            ),
        ).toBe(
            '- [/] thing <!-- @completed:2026-05-25T10:00:00+08:00 @started:2026-05-27T10:00:00+08:00 -->',
        );
    });

    it('no-ops on a non-task line', () => {
        expect(toggleInprogressMutator('plain text', FIXED_DEPS)).toBe('plain text');
    });
});

describe('toggleCompletedMutator', () => {
    it('flips todo to completed with @completed', () => {
        expect(toggleCompletedMutator('- [ ] thing', FIXED_DEPS)).toBe(
            '- [x] thing <!-- @completed:2026-05-27T10:00:00+08:00 -->',
        );
    });

    it('flips completed back to todo, removing @completed', () => {
        expect(
            toggleCompletedMutator(
                '- [x] thing <!-- @completed:2026-05-25T10:00:00+08:00 -->',
                FIXED_DEPS,
            ),
        ).toBe('- [ ] thing');
    });

    it('no-ops on a non-task line', () => {
        expect(toggleCompletedMutator('paragraph', FIXED_DEPS)).toBe('paragraph');
    });
});

describe('toggleCancelledMutator', () => {
    it('flips todo to cancelled with @cancelled', () => {
        expect(toggleCancelledMutator('- [ ] thing', FIXED_DEPS)).toBe(
            '- [!] thing <!-- @cancelled:2026-05-27T10:00:00+08:00 -->',
        );
    });

    it('flips cancelled back to todo, removing @cancelled', () => {
        expect(
            toggleCancelledMutator(
                '- [!] thing <!-- @cancelled:2026-05-25T10:00:00+08:00 -->',
                FIXED_DEPS,
            ),
        ).toBe('- [ ] thing');
    });
});
