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

/** What the old open-only showed: todo and in progress. */
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

/** A piece of the list's row: plain, the one under the cursor, or the dim hint. */
export interface StatePiece {
    readonly text: string;
    readonly tone: 'lead' | 'plain' | 'current' | 'hint';
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
    const widthOf = (ps: readonly StatePiece[]) => ps.reduce((w, p) => w + stringWidth(p.text), 0);
    const withHint = (ps: StatePiece[]): StatePiece[] | undefined => {
        const used = widthOf(ps);
        for (const hint of HINTS) {
            const gap = width - used - stringWidth(hint) - 1;
            if (gap >= 2)
                return [
                    ...ps,
                    { text: ' '.repeat(gap), tone: 'plain' },
                    { text: `${hint} `, tone: 'hint' },
                ];
        }
        return undefined;
    };
    const wide = pieces(full, '  ');
    const narrow = pieces(short, ' ', `  ${STATE_LABEL[current]}`);
    return withHint(wide) ?? (widthOf(wide) <= width ? wide : (withHint(narrow) ?? narrow));
}
