import stringWidth from 'string-width';
import type { Marker } from './markers';
import { STATE_GLYPH } from './tui-layout';

/**
 * The Tree's list of states to show, ticked like a spreadsheet column's
 * filter: the states in the list's order, what "shown" means for
 * the tree, and the list's row in the footer, pure.
 */

/** The states the list offers, in its order. */
export const STATES: readonly Marker[] = [
    'todo',
    'inprogress',
    'completed',
    'cancelled',
    'moved',
    'notes',
];

/** Todo and in progress: what the Tree opens on. */
export const OPEN_STATES: ReadonlySet<Marker> = new Set<Marker>(['todo', 'inprogress']);

export const STATE_LABEL: Readonly<Record<Marker, string>> = {
    todo: 'todo',
    inprogress: 'in progress',
    completed: 'done',
    cancelled: 'cancelled',
    moved: 'moved',
    notes: 'note',
};

/** The ticked states as the tree takes them: undefined when every one is ticked. */
export function shownStates(ticked: ReadonlySet<Marker>): ReadonlySet<Marker> | undefined {
    return STATES.every((s) => ticked.has(s)) ? undefined : ticked;
}

/** The states shown, as their glyphs in the list's order (`○◐`), for the tab strip. */
export function statesGlyphs(states: ReadonlySet<Marker>): string {
    return STATES.filter((s) => states.has(s))
        .map((s) => STATE_GLYPH[s])
        .join('');
}

/** A piece of the list's row: plain, the one under the cursor, a key, or the dim hint. */
export interface StatePiece {
    readonly text: string;
    readonly tone: 'lead' | 'plain' | 'current' | 'key' | 'hint';
}

export const STATES_LEAD = ' show  ';
/**
 * A state's checkbox, filled when it's shown: not `[x]`, which in tsk reads
 * as done. One column, and no emoji form: `☑` has one, and a terminal whose
 * font lacks it draws it in colour (Windows Terminal did).
 */
export const TICKED = '■';
export const UNTICKED = '□';
/** The keys, longest first: the first that fits is shown. */
const HINTS = ['space tick · ⏎ keep · esc', '⏎ keep · esc'];
const PRESET_HINTS = ['⏎ keep · esc', '⏎ · esc'];

/** The pieces' width. */
const widthOf = (ps: readonly StatePiece[]) => ps.reduce((w, p) => w + stringWidth(p.text), 0);

/** `ps` with the longest of `hints` that fits right-aligned in `width`; undefined when none does. */
function withHint(
    ps: StatePiece[],
    hints: readonly string[],
    width: number,
): StatePiece[] | undefined {
    const used = widthOf(ps);
    for (const hint of hints) {
        const gap = width - used - stringWidth(hint) - 1;
        if (gap >= 2)
            return [
                ...ps,
                { text: ' '.repeat(gap), tone: 'plain' },
                { text: `${hint} `, tone: 'hint' },
            ];
    }
    return undefined;
}

/**
 * The list in `width` columns: each state as `■ ○ todo`, the cursor's
 * picked out, the longest hint that fits on the right. Too narrow for the
 * names, each is `■○` and the cursor's name follows the list.
 */
export function stateRow(ticked: ReadonlySet<Marker>, at: number, width: number): StatePiece[] {
    const box = (s: Marker) => (ticked.has(s) ? TICKED : UNTICKED);
    const full = STATES.map((s) => `${box(s)} ${STATE_GLYPH[s]} ${STATE_LABEL[s]}`);
    const short = STATES.map((s) => `${box(s)}${STATE_GLYPH[s]}`);
    const current = STATES[at] ?? 'todo';
    const pieces = (items: readonly string[], sep: string, tail?: string): StatePiece[] => [
        { text: STATES_LEAD, tone: 'lead' },
        ...items.flatMap((text, i) => [
            ...(i > 0 ? [{ text: sep, tone: 'plain' as const }] : []),
            { text, tone: i === at ? ('current' as const) : ('plain' as const) },
        ]),
        ...(tail ? [{ text: tail, tone: 'plain' as const }] : []),
    ];
    const wide = pieces(full, '  ');
    const narrow = pieces(short, ' ', `  ${STATE_LABEL[current]}`);
    return (
        withHint(wide, HINTS, width) ??
        (widthOf(wide) <= width ? wide : (withHint(narrow, HINTS, width) ?? narrow))
    );
}

/**
 * A set of states `a` offers by name, `key` (its label's first letter)
 * picking it at once; `pick…` opens the tick list instead.
 */
export type Preset = { readonly key: string; readonly label: string } & (
    | { readonly states: ReadonlySet<Marker> | undefined }
    | { readonly pick: true }
);

export const PRESETS: readonly Preset[] = [
    { key: 'o', label: 'open', states: OPEN_STATES },
    { key: 'i', label: 'in progress', states: new Set<Marker>(['inprogress']) },
    { key: 'c', label: 'closed', states: new Set<Marker>(['completed', 'cancelled', 'moved']) },
    { key: 'a', label: 'all', states: undefined },
    { key: 'p', label: 'pick…', pick: true },
];

/** Where the row's cursor starts: the preset that is `states`, else `pick…`. */
export function presetOf(states: ReadonlySet<Marker> | undefined): number {
    const same = (a: ReadonlySet<Marker> | undefined) =>
        a === undefined || states === undefined
            ? a === states
            : a.size === states.size && [...a].every((s) => states.has(s));
    const at = PRESETS.findIndex((p) => 'states' in p && same(p.states));
    return at >= 0 ? at : PRESETS.findIndex((p) => 'pick' in p);
}

/**
 * The presets in `width` columns: each by name, its first letter a key, the
 * cursor's picked out, the longest hint that fits on the right. Too narrow
 * for the names, each is its letter and the cursor's name follows the row.
 */
export function presetRow(at: number, width: number): StatePiece[] {
    const lead: StatePiece = { text: STATES_LEAD, tone: 'lead' };
    const wide: StatePiece[] = [
        lead,
        ...PRESETS.flatMap((p, i): StatePiece[] => [
            ...(i > 0 ? [{ text: '  ', tone: 'plain' as const }] : []),
            ...(i === at
                ? [{ text: p.label, tone: 'current' as const }]
                : [
                      { text: p.key, tone: 'key' as const },
                      { text: p.label.slice(p.key.length), tone: 'plain' as const },
                  ]),
        ]),
    ];
    const narrow: StatePiece[] = [
        lead,
        ...PRESETS.flatMap((p, i): StatePiece[] => [
            ...(i > 0 ? [{ text: ' ', tone: 'plain' as const }] : []),
            { text: p.key, tone: i === at ? 'current' : 'key' },
        ]),
        { text: `  ${PRESETS[at]?.label ?? ''}`, tone: 'plain' },
    ];
    return (
        withHint(wide, PRESET_HINTS, width) ??
        (widthOf(wide) <= width ? wide : (withHint(narrow, PRESET_HINTS, width) ?? narrow))
    );
}
