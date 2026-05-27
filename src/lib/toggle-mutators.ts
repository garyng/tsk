import { generateId } from './ids';
import type { Marker } from './markers';
import { parseLine } from './parser';
import { localTimestamp } from './time';
import {
    removeMetadataEntry,
    setMetadataEntry,
    swapMarker,
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
 * `toggleTodo` / `toggleNote` share the same lifecycle pattern: wrap a
 * non-task line into a fresh task, unwrap an empty same-marker task back
 * to a blank line, otherwise no-op (don't blow away user content; don't
 * change a different marker's state).
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
export const toggleNoteMutator = makeCreationToggle('notes');
export const toggleInprogressMutator = makeStateToggle('inprogress', 'started');
export const toggleCompletedMutator = makeStateToggle('completed', 'completed');
export const toggleCancelledMutator = makeStateToggle('cancelled', 'cancelled');
