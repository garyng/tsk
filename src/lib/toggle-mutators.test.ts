import { describe, expect, it } from 'vitest';
import {
    enterInprogress,
    type ToggleDeps,
    toggleCancelledMutator,
    toggleCompletedMutator,
    toggleInprogressMutator,
    toggleNoteMutator,
    toggleP1Mutator,
    toggleP2Mutator,
    toggleP3Mutator,
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

    it('wraps an empty line as an empty todo with the cursor-spacer', () => {
        expect(toggleTodoMutator('', FIXED_DEPS)).toBe(
            '- [ ]  <!-- @id:idfix123 @created:2026-05-27T10:00:00+08:00 -->',
        );
    });

    it('unwraps an empty todo back to its indent', () => {
        expect(toggleTodoMutator('- [ ] <!-- @id:x -->', FIXED_DEPS)).toBe('');
        expect(toggleTodoMutator('    - [ ] <!-- @id:x -->', FIXED_DEPS)).toBe('    ');
    });

    it('no-ops on a todo that already has @id', () => {
        const line = '- [ ] still doing this <!-- @id:x -->';
        expect(toggleTodoMutator(line, FIXED_DEPS)).toBe(line);
    });

    it('promotes a markered-but-no-metadata todo by adding @id + @created', () => {
        expect(toggleTodoMutator('- [ ] needs id', FIXED_DEPS)).toBe(
            '- [ ] needs id <!-- @id:idfix123 @created:2026-05-27T10:00:00+08:00 -->',
        );
    });

    it('promotes a todo with @created but no @id by adding only @id', () => {
        // User has a hand-typed `@created` but never ran Alt+A — Alt+A
        // fills the missing `@id` without re-stamping the existing `@created`.
        expect(
            toggleTodoMutator(
                '- [ ] partial <!-- @created:2026-01-01T00:00:00+08:00 -->',
                FIXED_DEPS,
            ),
        ).toBe('- [ ] partial <!-- @created:2026-01-01T00:00:00+08:00 @id:idfix123 -->');
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

    it('promotes a markered-but-no-metadata note by adding @id + @created', () => {
        expect(toggleNoteMutator('- [n] aside', FIXED_DEPS)).toBe(
            '- [n] aside <!-- @id:idfix123 @created:2026-05-27T10:00:00+08:00 -->',
        );
    });

    it('flips a non-note task to a note — Alt+N works on tasks (M42)', () => {
        expect(toggleNoteMutator('- [ ] not a note <!-- @id:x -->', FIXED_DEPS)).toBe(
            '- [n] not a note <!-- @id:x -->',
        );
        expect(toggleNoteMutator('- [x] done <!-- @id:y -->', FIXED_DEPS)).toBe(
            '- [n] done <!-- @id:y -->',
        );
    });

    it('flips a proper note back to a todo — reversible (M42)', () => {
        expect(toggleNoteMutator('- [n] an aside <!-- @id:z -->', FIXED_DEPS)).toBe(
            '- [ ] an aside <!-- @id:z -->',
        );
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

describe('enterInprogress (shared by tsk.markNow auto-in-progress)', () => {
    it('moves a todo into [/] and stamps @started — identical to the Alt+S set', () => {
        expect(enterInprogress('- [ ] thing', FIXED_DEPS)).toBe(
            '- [/] thing <!-- @started:2026-05-27T10:00:00+08:00 -->',
        );
    });

    it('moves a completed task into [/], preserving prior @completed', () => {
        expect(
            enterInprogress(
                '- [x] thing <!-- @completed:2026-05-25T10:00:00+08:00 -->',
                FIXED_DEPS,
            ),
        ).toBe(
            '- [/] thing <!-- @completed:2026-05-25T10:00:00+08:00 @started:2026-05-27T10:00:00+08:00 -->',
        );
    });

    it('is idempotent on an already-[/] task — never re-stamps @started', () => {
        // markNow re-marking an in-progress task keeps its original start time;
        // unlike the toggle, enterInprogress never flips [/] back off.
        const line = '- [/] thing <!-- @started:2026-05-25T09:00:00+08:00 -->';
        expect(enterInprogress(line, FIXED_DEPS)).toBe(line);
    });

    it('no-ops on a non-task line', () => {
        expect(enterInprogress('plain text', FIXED_DEPS)).toBe('plain text');
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

describe('toggleP1 / toggleP2 / toggleP3 mutators', () => {
    it('adds @priority:N when absent', () => {
        expect(toggleP1Mutator('- [ ] thing', FIXED_DEPS)).toBe('- [ ] thing <!-- @priority:1 -->');
        expect(toggleP3Mutator('- [ ] thing', FIXED_DEPS)).toBe('- [ ] thing <!-- @priority:3 -->');
    });

    it('removes the entry when toggling the same level twice', () => {
        const a = toggleP2Mutator('- [ ] x', FIXED_DEPS);
        expect(a).toBe('- [ ] x <!-- @priority:2 -->');
        const b = toggleP2Mutator(a, FIXED_DEPS);
        expect(b).toBe('- [ ] x');
    });

    it('swaps levels via mutual exclusion (mismatched → overwrite)', () => {
        expect(toggleP2Mutator('- [ ] x <!-- @priority:1 -->', FIXED_DEPS)).toBe(
            '- [ ] x <!-- @priority:2 -->',
        );
        expect(toggleP3Mutator('- [ ] x <!-- @priority:2 -->', FIXED_DEPS)).toBe(
            '- [ ] x <!-- @priority:3 -->',
        );
    });

    it('no-ops on a non-task line', () => {
        expect(toggleP1Mutator('plain text', FIXED_DEPS)).toBe('plain text');
    });
});
