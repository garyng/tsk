import type { Marker, Task } from './parser';

/**
 * Structural range tuple. Kept vscode-runtime-free so this module is
 * importable from vitest (where `vscode` isn't available). The activation
 * layer converts to `vscode.Range` at the `editor.setDecorations` boundary.
 *
 * Coordinates are zero-indexed, matching VSCode's `Position` convention.
 */
export interface RangeLike {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
}

/**
 * Marker → `contributes.colors` id. `todo` is intentionally undefined: we
 * don't override the editor's default foreground for in-flight tasks. The
 * other five resolve to the entries declared in `package.json`'s
 * `contributes.colors`.
 */
export const MARKER_THEME_COLOR_IDS: Record<Marker, string | undefined> = {
    todo: undefined,
    inprogress: 'tsk.marker.inprogress',
    completed: 'tsk.marker.completed',
    moved: 'tsk.marker.moved',
    cancelled: 'tsk.marker.cancelled',
    notes: 'tsk.marker.notes',
};

/**
 * Markers that visually strike through their marker triplet. Only the two
 * fully-terminal "this task is over and gone" states. `moved` is terminal
 * too but stays legible — the orange color signals relocation, the link to
 * the new task is the more important visual cue.
 */
export const MARKER_STRIKETHROUGH: ReadonlySet<Marker> = new Set<Marker>([
    'completed',
    'cancelled',
]);

/**
 * Bucket parsed tasks into ranges to decorate, keyed by marker. Each range
 * covers the three characters `[X]` so themes can color bracket + marker
 * as a unit.
 *
 * Bracket position is derived from `raw.indexOf('[', indent.length)` rather
 * than assumed to be `indent.length + 2`. This:
 *   - works equally for `-`, `*`, `+` bullets without branching;
 *   - tolerates `-   [X]` (extra whitespace between bullet and bracket);
 *   - cannot false-positive on a `[` inside content, because for any parsed
 *     task the marker bracket appears before any content character.
 *
 * Pure — no `vscode` import.
 */
export function computeMarkerRanges(tasks: readonly Task[]): Map<Marker, RangeLike[]> {
    const out = new Map<Marker, RangeLike[]>();
    for (const task of tasks) {
        const bracketStart = task.raw.indexOf('[', task.indent.length);
        if (bracketStart < 0) continue;
        const range: RangeLike = {
            startLine: task.line,
            startCol: bracketStart,
            endLine: task.line,
            endCol: bracketStart + 3,
        };
        let bucket = out.get(task.marker);
        if (!bucket) {
            bucket = [];
            out.set(task.marker, bucket);
        }
        bucket.push(range);
    }
    return out;
}
