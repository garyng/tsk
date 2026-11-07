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
 * The lead, then `items` in rows of `width` columns: whole items, a row after
 * the first starting under the first item, and the longest of `hints` that
 * fits right-aligned on the last row, else on a row of its own.
 */
function wrapItems(
    items: readonly StatePiece[][],
    width: number,
    hints: readonly string[],
): StatePiece[][] {
    const indent = stringWidth(STATES_LEAD);
    const rows: StatePiece[][] = [[{ text: STATES_LEAD, tone: 'lead' }]];
    let used = indent;
    for (const item of items) {
        const row = rows[rows.length - 1] ?? [];
        const w = widthOf(item);
        if (used === indent) {
            row.push(...item);
            used += w;
        } else if (used + 2 + w <= width) {
            row.push({ text: '  ', tone: 'plain' }, ...item);
            used += 2 + w;
        } else {
            rows.push([{ text: ' '.repeat(indent), tone: 'plain' }, ...item]);
            used = indent + w;
        }
    }
    const last = rows.length - 1;
    const hinted = withHint(rows[last] ?? [], hints, width);
    if (hinted) rows[last] = hinted;
    else {
        const own = withHint([], hints, width);
        if (own) rows.push(own);
    }
    return rows;
}

/**
 * The list as rows of `width` columns: each state as `■ ○ todo`, the
 * cursor's picked out, the longest hint that fits on the right.
 */
export function stateRows(ticked: ReadonlySet<Marker>, at: number, width: number): StatePiece[][] {
    const box = (s: Marker) => (ticked.has(s) ? TICKED : UNTICKED);
    return wrapItems(
        STATES.map((s, i) => [
            {
                text: `${box(s)} ${STATE_GLYPH[s]} ${STATE_LABEL[s]}`,
                tone: i === at ? 'current' : 'plain',
            },
        ]),
        width,
        HINTS,
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
 * The presets as rows of `width` columns: each by name, its first letter a
 * key, the cursor's picked out, the longest hint that fits on the right.
 */
export function presetRows(at: number, width: number): StatePiece[][] {
    return wrapItems(
        PRESETS.map((p, i): StatePiece[] =>
            i === at
                ? [{ text: p.label, tone: 'current' }]
                : [
                      { text: p.key, tone: 'key' },
                      { text: p.label.slice(p.key.length), tone: 'plain' },
                  ],
        ),
        width,
        PRESET_HINTS,
    );
}
