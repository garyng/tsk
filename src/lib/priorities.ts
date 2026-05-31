/**
 * Single source of truth for task priorities.
 *
 * Mirrors the {@link MARKERS} pattern (see `markers.ts`). Today only M4/B
 * (priority line decorations) will consume this; M5 (`toggleP1`/`P2`/`P3`)
 * will pick up the `keybinding` / `commandSuffix` fields when those land.
 */
export interface PriorityDef {
    /** Priority level. Spec pins this to {1, 2, 3}. */
    level: number;
    /**
     * Decoration background RGB triple. Hue is hardcoded per spec; only the
     * `tsk.decorations.priority.opacity` setting is user-tunable. The
     * activation layer builds the actual `rgba(r, g, b, opacity)` string.
     */
    rgb: readonly [number, number, number];
    /** Human-readable label (used in future UI: hovers, command titles). */
    label: string;
}

export const PRIORITIES = [
    { level: 1, rgb: [255, 99, 71], label: 'High' },
    { level: 2, rgb: [255, 200, 0], label: 'Medium' },
    { level: 3, rgb: [100, 149, 237], label: 'Low' },
] as const satisfies readonly PriorityDef[];

/** The set of legal priority levels, derived from {@link PRIORITIES}. */
export type PriorityLevel = (typeof PRIORITIES)[number]['level'];

/**
 * Look up the {@link PriorityDef} for a level. Returns `undefined` for
 * out-of-range levels (e.g. `0`, `4`).
 */
export function priorityForLevel(level: number): (typeof PRIORITIES)[number] | undefined {
    return PRIORITIES.find((p) => p.level === level);
}
