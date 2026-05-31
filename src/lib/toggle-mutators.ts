import { generateId } from './ids';
import type { Marker } from './markers';
import { parseLine } from './parser';
import type { PriorityLevel } from './priorities';
import { localTimestamp } from './time';
import {
    promoteMissingMetadata,
    removeMetadataEntry,
    setMetadataEntry,
    swapMarker,
    toggleMetadataEntry,
    unwrapTask,
    wrapAsTask,
} from './toggle';

/**
 * Dependencies a toggle mutator may read at apply time. Injecting these keeps
 * the mutators pure for vitest — tests pass deterministic fakes, the
 * activation layer passes {@link defaultToggleDeps}.
 */
export interface ToggleDeps {
    /** Fresh `@id` value (consumed by `toggleTodo` / `toggleNote`). */
    generateId: () => string;
    /** Local timestamp for `@started` / `@completed` / `@cancelled` / `@created`. */
    now: () => string;
}

/** Production defaults — wired in by the activation layer. */
export const defaultToggleDeps: ToggleDeps = {
    generateId,
    now: localTimestamp,
};

/**
 * `toggleTodo` / `toggleNote` share the same lifecycle pattern:
 *
 *   - Non-task line → wrap into a fresh task with `@id` + `@created`.
 *   - Same-marker empty task → unwrap back to a blank line.
 *   - Same-marker non-empty task missing `@id` → promote to a "proper
 *     todo" by filling in `@id` (always) and `@created` (if also
 *     missing). Mirrors `wrapAsTask`'s shape so a hand-typed task
 *     becomes indistinguishable from one Alt+A produced from scratch.
 *   - Otherwise → no-op (don't blow away content; don't disturb a
 *     different marker's state; don't re-stamp an already-proper task).
 */
function makeCreationToggle(targetMarker: Marker) {
    return (line: string, deps: ToggleDeps): string => {
        const parsed = parseLine(line);
        if (!parsed) {
            return wrapAsTask(line, targetMarker, {
                id: deps.generateId(),
                timestamp: deps.now(),
            });
        }
        if (parsed.marker === targetMarker && parsed.content === '') {
            return unwrapTask(line);
        }
        if (parsed.marker === targetMarker && !parsed.metadata.has('id')) {
            const promoted = promoteMissingMetadata(line, deps);
            if (promoted !== null) return promoted;
        }
        return line;
    };
}

/**
 * `toggleInprogress` / `toggleCompleted` / `toggleCancelled` share the
 * state-marker pattern: on first toggle, swap the marker and set the
 * `@<timestampKey>` metadata; on a second toggle (same marker), swap back
 * to `todo` and remove the metadata.
 *
 * If the task is already in a *different* non-todo state (e.g., toggling
 * `inprogress` on a `completed` task), this swaps marker and sets the new
 * timestamp without touching prior state markers' metadata — that's by
 * design, the user can use the dedicated toggle to clear those.
 */
function makeStateToggle(targetMarker: Marker, timestampKey: string) {
    return (line: string, deps: ToggleDeps): string => {
        const parsed = parseLine(line);
        if (!parsed) return line;
        if (parsed.marker === targetMarker) {
            return removeMetadataEntry(swapMarker(line, 'todo'), timestampKey);
        }
        return setMetadataEntry(swapMarker(line, targetMarker), timestampKey, deps.now());
    };
}

export const toggleTodoMutator = makeCreationToggle('todo');

/**
 * `toggleNote` is a hybrid — it keeps the creation pattern (so Alt+N still turns
 * a plain line into a note) *and* swaps the marker on an existing task (so Alt+N
 * flips any task to/from a note, the way Alt+S/C/X flip their own markers):
 *
 *   - Non-task line → wrap into a `[n]` note (`@id` + `@created`).
 *   - Task with a non-note marker → swap the marker to `[n]`.
 *   - `[n]` task, empty → unwrap back to a blank line.
 *   - `[n]` task, id-less → promote (fill `@id` + `@created`).
 *   - `[n]` task, proper → swap back to `[ ]` todo (so Alt+N is reversible).
 */
export const toggleNoteMutator = (line: string, deps: ToggleDeps): string => {
    const parsed = parseLine(line);
    if (!parsed) {
        return wrapAsTask(line, 'notes', { id: deps.generateId(), timestamp: deps.now() });
    }
    if (parsed.marker !== 'notes') {
        return swapMarker(line, 'notes');
    }
    if (parsed.content === '') return unwrapTask(line);
    if (!parsed.metadata.has('id')) {
        const promoted = promoteMissingMetadata(line, deps);
        if (promoted !== null) return promoted;
    }
    return swapMarker(line, 'todo');
};

export const toggleInprogressMutator = makeStateToggle('inprogress', 'started');
export const toggleCompletedMutator = makeStateToggle('completed', 'completed');
export const toggleCancelledMutator = makeStateToggle('cancelled', 'cancelled');

/**
 * `toggleP1` / `toggleP2` / `toggleP3` toggle the `@priority:N` metadata.
 * Mutual exclusion is automatic — `toggleMetadataEntry`'s "mismatched →
 * overwrite" branch swaps levels in one step.
 *
 * The `_deps` parameter is unused; it exists to keep all toggle mutators
 * on the same signature so the activation layer can bind them uniformly.
 */
function makeTogglePriority(level: PriorityLevel) {
    const value = String(level);
    return (line: string, _deps: ToggleDeps): string =>
        toggleMetadataEntry(line, 'priority', value);
}

export const toggleP1Mutator = makeTogglePriority(1);
export const toggleP2Mutator = makeTogglePriority(2);
export const toggleP3Mutator = makeTogglePriority(3);
