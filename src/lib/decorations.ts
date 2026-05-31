import { MARKERS, type Marker } from './markers';
import type { Task } from './parser';
import { type PriorityLevel, priorityForLevel } from './priorities';

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
 * Marker → `contributes.colors` id, derived from the registry. `todo` resolves
 * to `undefined` (no color override → editor default foreground wins); the
 * other five resolve to their declared `contributes.colors` id.
 */
export const MARKER_THEME_COLOR_IDS: Record<Marker, string | undefined> = Object.fromEntries(
    MARKERS.map((m) => [m.name, m.color?.id]),
) as Record<Marker, string | undefined>;

/**
 * Markers that visually strike through their marker triplet, derived from
 * the registry's `strikethrough` flag.
 */
export const MARKER_STRIKETHROUGH: ReadonlySet<Marker> = new Set(
    MARKERS.filter((m) => m.strikethrough).map((m) => m.name),
);

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

/**
 * Compose an `rgba(r, g, b, opacity)` string for the priority `level`. RGB
 * lives in the `PRIORITIES` registry; only the opacity is user-settable via
 * `tsk.decorations.priority.opacity`.
 *
 * The `PriorityLevel` parameter is a type-checked union of legal levels —
 * the runtime guard exists only to catch `as`-bypassed callers.
 */
export function priorityBackgroundColor(level: PriorityLevel, opacity: number): string {
    const def = priorityForLevel(level);
    if (!def) throw new Error(`unknown priority level: ${level}`);
    const [r, g, b] = def.rgb;
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/** Matches a string that is exactly `1`, `2`, or `3` — the only legal levels. */
const PRIORITY_VALUE_RE = /^[1-3]$/;

/**
 * Bucket parsed tasks into whole-line ranges to decorate, keyed by priority.
 *
 * A task qualifies only when its `@priority` metadata value is exactly `'1'`,
 * `'2'`, or `'3'`. Anything else — no metadata, flag-form `@priority` (value
 * `null`), empty `@priority:` (value `''`), `@priority:0` / `:4` / `:high` —
 * is dropped silently. Decoration code should never produce noisy stale
 * highlights; warnings for malformed priority values land with the broader
 * metadata-key dispatch work in M5+.
 *
 * The range is whole-line (start col 0 → end col = `raw.length`). The
 * activation layer applies `isWholeLine: true` on the decoration type, so
 * the columns are illustrative — VSCode extends the background to the
 * editor's right edge regardless.
 *
 * Pure — no `vscode` import.
 */
export function computePriorityRanges(tasks: readonly Task[]): Map<PriorityLevel, RangeLike[]> {
    const out = new Map<PriorityLevel, RangeLike[]>();
    for (const task of tasks) {
        const value = task.metadata.get('priority');
        if (typeof value !== 'string') continue;
        if (!PRIORITY_VALUE_RE.test(value)) continue;
        const level = Number.parseInt(value, 10) as PriorityLevel;
        const range: RangeLike = {
            startLine: task.line,
            startCol: 0,
            endLine: task.line,
            endCol: task.raw.length,
        };
        let bucket = out.get(level);
        if (!bucket) {
            bucket = [];
            out.set(level, bucket);
        }
        bucket.push(range);
    }
    return out;
}

/**
 * Non-greedy match of an entire `<!-- ... -->` HTML comment block. `[\s\S]`
 * tolerates a stray newline inside (parser strips trailing `\r` but doesn't
 * forbid a `\n` inside the comment body); the `?` keeps multi-comment lines
 * from being captured as one giant match.
 */
const METADATA_COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * Find every inline `<!-- ... -->` block across the given tasks and emit
 * one `RangeLike` per comment (covering the full `<!--` … `-->` span,
 * including the brackets and dashes).
 *
 * The activation layer applies a single dimmed decoration type to this
 * flat list so metadata recedes into the editor background. The
 * hover-on-task surface displays those parsed values on demand; the
 * dimmed comment text is present-but-quiet bookkeeping.
 *
 * Unclosed `<!--` is silently dropped — non-greedy matching just won't
 * fire without a closing `-->`. Pure — no `vscode` import.
 */
export function computeMetadataRanges(tasks: readonly Task[]): RangeLike[] {
    const out: RangeLike[] = [];
    for (const task of tasks) {
        for (const match of task.raw.matchAll(METADATA_COMMENT_RE)) {
            if (match.index === undefined) continue;
            out.push({
                startLine: task.line,
                startCol: match.index,
                endLine: task.line,
                endCol: match.index + match[0].length,
            });
        }
    }
    return out;
}
