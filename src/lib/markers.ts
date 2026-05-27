/**
 * Single source of truth for every `.tsk` task marker.
 *
 * Anything that needs marker-derived data — the parser regex + canonicalizer,
 * decoration styles, `package.json#contributes.colors`, future toggle command
 * labels — derives from {@link MARKERS}. Adding a new marker means appending
 * one entry here, then mirroring it into `package.json` and the grammar JSON;
 * `markers.test.ts` fails the build if those JSON files drift.
 *
 * See "Registry pattern for finite enumerations" in `plans/2026-05-24_tsk.md`
 * for the broader convention this file implements.
 */
export interface MarkerDef {
    /** Canonical lowercase name. The derived {@link Marker} type is the union of these. */
    name: string;
    /**
     * Characters accepted in the `[X]` slot. The first entry is canonical
     * (used when the extension writes a marker); subsequent entries are
     * case-tolerant aliases parsed on read (e.g. `'x'` then `'X'`).
     */
    symbols: readonly [string, ...string[]];
    /**
     * `contributes.colors` entry that themes can override and decorations
     * read via `ThemeColor`. `undefined` means no override — the editor's
     * default foreground wins (used for `todo`).
     */
    color?: {
        id: string;
        description: string;
        light: string;
        dark: string;
    };
    /** Apply `text-decoration: line-through` to the marker triplet. */
    strikethrough: boolean;
    /**
     * TextMate scope this marker contributes via `syntaxes/tsk.tmLanguage.json`.
     * Mirrored hand by hand into the grammar JSON; the drift test verifies
     * every scope name listed here actually appears in the grammar source.
     */
    scopeName: string;
    /** Human-readable label, used for future UI surfaces (command titles, hovers). */
    label: string;
}

export const MARKERS = [
    {
        name: 'todo',
        symbols: [' '],
        // Explicit `color: undefined` (rather than omitting the key) keeps
        // the `color` field present in the literal type, so `m.color?.id`
        // and `m.color !== undefined` type-check across the whole union.
        color: undefined,
        strikethrough: false,
        scopeName: 'markup.task-marker.todo.tsk',
        label: 'Todo',
    },
    {
        name: 'inprogress',
        symbols: ['/'],
        color: {
            id: 'tsk.marker.inprogress',
            description: 'Foreground color of the [/] in-progress task marker triplet.',
            light: '#1976d2',
            dark: '#3794ff',
        },
        strikethrough: false,
        scopeName: 'markup.task-marker.inprogress.tsk',
        label: 'In progress',
    },
    {
        name: 'completed',
        symbols: ['x', 'X'],
        color: {
            id: 'tsk.marker.completed',
            description: 'Foreground color of the [x] completed task marker triplet.',
            light: '#388e3c',
            dark: '#67c23a',
        },
        // Reads as "done!" with just the green color; striking it through felt
        // like "discarded / no longer relevant", which is what `cancelled`
        // already conveys.
        strikethrough: false,
        scopeName: 'markup.task-marker.completed.tsk',
        label: 'Completed',
    },
    {
        name: 'moved',
        symbols: ['>'],
        color: {
            id: 'tsk.marker.moved',
            description: 'Foreground color of the [>] moved task marker triplet.',
            light: '#f57c00',
            dark: '#ff9d00',
        },
        strikethrough: false,
        scopeName: 'markup.task-marker.moved.tsk',
        label: 'Moved',
    },
    {
        name: 'cancelled',
        symbols: ['!'],
        color: {
            id: 'tsk.marker.cancelled',
            description: 'Foreground color of the [!] cancelled task marker triplet.',
            light: '#757575',
            dark: '#9e9e9e',
        },
        strikethrough: true,
        scopeName: 'markup.task-marker.cancelled.tsk',
        label: 'Cancelled',
    },
    {
        name: 'notes',
        symbols: ['n', 'N'],
        color: {
            id: 'tsk.marker.notes',
            description: 'Foreground color of the [n] notes task marker triplet.',
            light: '#7e57c2',
            dark: '#bb6dd9',
        },
        strikethrough: false,
        scopeName: 'markup.task-marker.notes.tsk',
        label: 'Notes',
    },
] as const satisfies readonly MarkerDef[];

/** Canonical marker name. Derived from {@link MARKERS} so the union stays in sync. */
export type Marker = (typeof MARKERS)[number]['name'];

/**
 * All accepted marker characters, escaped for safe inclusion in a regex
 * character class. Backslash / `]` / `-` / `^` get an escape; everything
 * else passes through. Build the regex with e.g.
 * `` `[${MARKER_SYMBOL_CHAR_CLASS}]` ``.
 */
export const MARKER_SYMBOL_CHAR_CLASS: string = MARKERS.flatMap((m) => [...m.symbols])
    .join('')
    .replace(/[\\\]\-^]/g, '\\$&');

/**
 * Look up the canonical {@link Marker} for a marker character (e.g. `' '`,
 * `'x'`, `'X'`). Returns `undefined` for unknown characters.
 */
export function markerForSymbol(ch: string): Marker | undefined {
    for (const def of MARKERS) {
        if ((def.symbols as readonly string[]).includes(ch)) {
            return def.name as Marker;
        }
    }
    return undefined;
}
