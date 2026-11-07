import stringWidth from 'string-width';
import type { Marker } from './markers';

/**
 * The `tsk` TUI's keys, pure, in one table ({@link KEY_TABLE}) that drives
 * what a key does ({@link keysToActions}), the footer's hints for the
 * selected task ({@link hintsFor}) and the grouped `?` overlay
 * ({@link helpLines}) — so a key can't be bound and undocumented, and a hint
 * can't name a key that does something else.
 *
 * Ink hands `useInput` whatever arrived in one read — five quick `j`s come as
 * `"jjjjj"` (key repeat, a paste, tmux `send-keys -N`) — so every character
 * is an action of its own; comparing the whole input to `'j'` would silently
 * drop them all.
 *
 * No key changes the file: `m` sends the followed Claude a message, and the
 * session makes any change with `tsk`, so it always knows.
 */

export type TuiAction =
    | 'down'
    | 'up'
    | 'top'
    | 'bottom'
    | 'quit'
    | 'switchView'
    | 'prevView'
    | 'sessionView'
    | 'treeView'
    | 'stepsView'
    | 'zoomIn'
    | 'zoomOut'
    | 'escape'
    | 'message'
    | 'mark'
    | 'open'
    | 'states'
    | 'fold'
    | 'foldAll'
    | 'unfoldAll'
    | 'filter'
    | 'deps'
    | 'detail'
    | 'detailDown'
    | 'detailUp'
    | 'detailPageDown'
    | 'detailPageUp'
    | 'detailGrow'
    | 'detailShrink'
    | 'detailReset'
    | 'openFile'
    | 'help';

/** The subset of Ink's `Key` the map reads. */
export interface KeyFlags {
    readonly upArrow?: boolean;
    readonly downArrow?: boolean;
    readonly leftArrow?: boolean;
    readonly rightArrow?: boolean;
    readonly return?: boolean;
    readonly tab?: boolean;
    readonly backspace?: boolean;
    readonly delete?: boolean;
    readonly escape?: boolean;
    readonly ctrl?: boolean;
    readonly shift?: boolean;
    readonly pageUp?: boolean;
    readonly pageDown?: boolean;
}

/** The `?` overlay's sections, in order; one with no keys is left out. */
export const KEY_GROUPS = ['move', 'views', 'task', 'detail', 'other'] as const;
export type KeyGroup = (typeof KEY_GROUPS)[number];

export type TuiView = 'session' | 'tree' | 'layers' | 'deps';

/** What decides which hints the footer shows, and how they read. */
export interface KeyContext {
    readonly view: TuiView;
    /** The selected task's state; none when nothing is selected. */
    readonly marker?: Marker;
    /** Zoomed into a task in the tree view. */
    readonly zoomed?: boolean;
    /** The selected task is folded in the tree view. */
    readonly folded?: boolean;
    /** The tree view is filtered, by a filter kept with Enter. */
    readonly filtered?: boolean;
    /** A Claude session is followed, so `m` has someone to message. */
    readonly canTell?: boolean;
    /** The selected task is in a file beside this one, which the tree doesn't show. */
    readonly outside?: boolean;
    /** The selected task is marked for the next message. */
    readonly marked?: boolean;
    /** How many tasks are marked. */
    readonly marks?: number;
    /** The `?` overlay is open. */
    readonly help?: boolean;
}

type FlagName = Exclude<keyof KeyFlags, 'ctrl' | 'shift'>;

/** One action's keys: characters (each character of a read is a key), flags Ink sets for special keys, and ctrl-characters. */
interface Binding {
    readonly action: TuiAction;
    readonly chars?: readonly string[];
    readonly flags?: readonly FlagName[];
    /** For `flags`: only with shift held (`true`), or only without it (`false`). */
    readonly shift?: boolean;
    readonly ctrl?: readonly string[];
}

export interface KeyRow {
    /** As the `?` overlay shows them. */
    readonly keys: string;
    /** What they do, in the `?` overlay. */
    readonly help: string;
    readonly group: KeyGroup;
    readonly bind: readonly Binding[];
    /**
     * In the footer: its keys there (default {@link KeyRow.keys}), its label
     * for the selected task, its place (lower first), and when it applies
     * (default always). A pinned hint stays last when the footer is too
     * narrow for the rest. Without `hint`, the row is only in `?`.
     */
    readonly hint?: {
        readonly keys?: string;
        readonly label: string | ((ctx: KeyContext) => string);
        readonly order: number;
        readonly when?: (ctx: KeyContext) => boolean;
        readonly pinned?: boolean;
    };
}

const hasTask = (ctx: KeyContext) => ctx.marker !== undefined;
/** A selected task the tree has, to zoom into. */
const canZoom = (ctx: KeyContext) => hasTask(ctx) && ctx.outside !== true;

export const KEY_TABLE: readonly KeyRow[] = [
    {
        keys: 'j/k ↑/↓',
        help: 'move',
        group: 'move',
        bind: [
            { action: 'down', chars: ['j'], flags: ['downArrow'] },
            { action: 'up', chars: ['k'], flags: ['upArrow'] },
        ],
    },
    {
        keys: 'g/G',
        help: 'top / bottom',
        group: 'move',
        bind: [
            { action: 'top', chars: ['g'] },
            { action: 'bottom', chars: ['G'] },
        ],
    },
    {
        keys: 'tab',
        help: 'next view (shift: back)',
        group: 'views',
        bind: [
            { action: 'prevView', flags: ['tab'], shift: true },
            { action: 'switchView', chars: ['\t'], flags: ['tab'], shift: false },
        ],
    },
    {
        keys: '1/2/3',
        help: 'session / tree / steps view',
        group: 'views',
        bind: [
            { action: 'sessionView', chars: ['1'] },
            { action: 'treeView', chars: ['2'] },
            { action: 'stepsView', chars: ['3'] },
        ],
    },
    {
        keys: 'enter/l',
        help: 'zoom into the task',
        group: 'views',
        // Enter inside a batched read arrives as a character, not as the `return` flag.
        bind: [{ action: 'zoomIn', chars: ['\r', 'l'], flags: ['return', 'rightArrow'] }],
        hint: { keys: '⏎', label: 'zoom', order: 40, when: canZoom },
    },
    {
        keys: 'u/h/esc',
        help: 'zoom out, leave deps (esc first closes this list, unmarks, clears the filter)',
        group: 'views',
        // Esc first: a click on the hint does what Esc does.
        bind: [
            { action: 'escape', flags: ['escape'] },
            { action: 'zoomOut', chars: ['u', 'h'], flags: ['backspace', 'delete', 'leftArrow'] },
        ],
        hint: {
            keys: 'esc',
            label: (ctx) =>
                ctx.help
                    ? 'close'
                    : (ctx.marks ?? 0) > 0
                      ? 'unmark all'
                      : ctx.view === 'deps'
                        ? 'back'
                        : ctx.filtered
                          ? 'clear'
                          : 'out',
            order: 5,
            when: (ctx) =>
                ctx.help === true ||
                (ctx.marks ?? 0) > 0 ||
                ctx.view === 'deps' ||
                ctx.zoomed === true ||
                ctx.filtered === true,
        },
    },
    {
        keys: 'd',
        help: 'what it needs / needs it',
        group: 'views',
        bind: [{ action: 'deps', chars: ['d'] }],
        hint: { label: 'deps', order: 30, when: hasTask },
    },
    {
        keys: 'a',
        help: 'which states the tree shows: o open, i in progress, c closed, a all, p pick',
        group: 'views',
        bind: [{ action: 'states', chars: ['a'] }],
        hint: { label: 'states', order: 70, when: (ctx) => ctx.view === 'tree' },
    },
    {
        keys: 'space',
        help: 'fold / unfold it (tree; on a task with none under it, its parent)',
        group: 'views',
        bind: [{ action: 'fold', chars: [' '] }],
        hint: {
            label: (ctx) => (ctx.folded ? 'unfold' : 'fold'),
            order: 45,
            when: (ctx) => ctx.view === 'tree' && hasTask(ctx) && !ctx.filtered,
        },
    },
    {
        keys: 'z/Z',
        help: 'fold / unfold everything (tree)',
        group: 'views',
        bind: [
            { action: 'foldAll', chars: ['z'] },
            { action: 'unfoldAll', chars: ['Z'] },
        ],
    },
    {
        keys: '/',
        help: 'filter the tree (⏎ keeps it, esc clears)',
        group: 'views',
        bind: [{ action: 'filter', chars: ['/'] }],
        hint: { label: 'filter', order: 42, when: (ctx) => ctx.view === 'tree' },
    },
    {
        keys: 'm',
        help: 'message the followed Claude about it (⏎ sends, esc cancels)',
        group: 'task',
        bind: [{ action: 'message', chars: ['m'] }],
        hint: { label: 'message', order: 10, when: (ctx) => hasTask(ctx) && ctx.canTell === true },
    },
    {
        keys: 'v',
        help: 'mark it, for one message about every marked task (esc unmarks all)',
        group: 'task',
        bind: [{ action: 'mark', chars: ['v'] }],
        hint: {
            label: (ctx) => (ctx.marked ? 'unmark' : 'mark'),
            order: 65,
            when: (ctx) => hasTask(ctx) && ctx.canTell === true,
        },
    },
    {
        keys: 'e',
        help: 'open in VS Code',
        group: 'task',
        bind: [{ action: 'open', chars: ['e'] }],
        hint: { label: 'open', order: 60, when: hasTask },
    },
    {
        keys: 'p',
        help: 'detail pane: the task and its plan',
        group: 'detail',
        bind: [{ action: 'detail', chars: ['p'] }],
    },
    {
        keys: 'J/K',
        help: 'scroll the detail (PgDn/PgUp: a page)',
        group: 'detail',
        bind: [
            { action: 'detailDown', chars: ['J'] },
            { action: 'detailUp', chars: ['K'] },
            { action: 'detailPageDown', flags: ['pageDown'] },
            { action: 'detailPageUp', flags: ['pageUp'] },
        ],
    },
    {
        keys: '+/-/=',
        help: 'grow / shrink / reset the detail (or drag its edge)',
        group: 'detail',
        bind: [
            { action: 'detailGrow', chars: ['+'] },
            { action: 'detailShrink', chars: ['-'] },
            { action: 'detailReset', chars: ['='] },
        ],
    },
    {
        keys: 'o',
        help: 'open the plan at that line',
        group: 'detail',
        bind: [{ action: 'openFile', chars: ['o'] }],
    },
    {
        keys: '?',
        help: 'these keys',
        group: 'other',
        bind: [{ action: 'help', chars: ['?'] }],
        hint: { label: 'keys', order: 1000, pinned: true },
    },
    {
        keys: 'q ctrl+c',
        help: 'quit',
        group: 'other',
        bind: [{ action: 'quit', chars: ['q'], ctrl: ['c'] }],
    },
];

const BINDINGS: readonly Binding[] = KEY_TABLE.flatMap((r) => r.bind);
const CHAR_ACTIONS: ReadonlyMap<string, TuiAction> = new Map(
    BINDINGS.flatMap((b) => (b.chars ?? []).map((ch) => [ch, b.action] as const)),
);

export function keysToActions(input: string, key: KeyFlags): TuiAction[] {
    if (key.ctrl) {
        const ctrl = BINDINGS.find((b) => b.ctrl?.includes(input));
        if (ctrl) return [ctrl.action];
    }
    const flagged = BINDINGS.find(
        (b) => b.flags?.some((f) => key[f]) && (b.shift === undefined || b.shift === !!key.shift),
    );
    if (flagged) return [flagged.action];
    const actions: TuiAction[] = [];
    for (const ch of input) {
        const action = CHAR_ACTIONS.get(ch);
        if (action) actions.push(action);
    }
    return actions;
}

/** A footer hint: its keys (in the accent) and what they do now. */
export interface Hint {
    readonly keys: string;
    readonly label: string;
    readonly pinned?: boolean;
    /** What a click on it does: its row's first action. */
    readonly action: TuiAction;
}

/** The hints that apply in `ctx`, in their order, the pinned `? keys` last. */
export function hintsFor(ctx: KeyContext): Hint[] {
    return KEY_TABLE.flatMap((r) => {
        const h = r.hint;
        if (!h || (h.when && !h.when(ctx))) return [];
        const label = typeof h.label === 'function' ? h.label(ctx) : h.label;
        const action = r.bind[0]?.action;
        if (!action) return [];
        return [{ keys: h.keys ?? r.keys, label, pinned: h.pinned, order: h.order, action }];
    })
        .sort((a, b) => Number(a.pinned ?? false) - Number(b.pinned ?? false) || a.order - b.order)
        .map(({ order: _, ...hint }) => hint);
}

/** A hint's columns in the footer: ` keys label `. */
export const hintWidth = (h: Hint): number => stringWidth(` ${h.keys} ${h.label} `);

/**
 * The hints as the footer's rows, whole hints in their order (`hintsFor`
 * puts the pinned last): the first row `first` columns wide, leaving room
 * for what sits on its right, the others `width`.
 */
export function wrapHints(hints: readonly Hint[], width: number, first = width): Hint[][] {
    const rows: Hint[][] = [[]];
    let used = 0;
    for (const h of hints) {
        const row = rows[rows.length - 1] ?? [];
        if (row.length > 0 && used + hintWidth(h) > (rows.length === 1 ? first : width)) {
            rows.push([h]);
            used = hintWidth(h);
        } else {
            row.push(h);
            used += hintWidth(h);
        }
    }
    return rows;
}

/** A line of the `?` overlay: a group's heading, or a row of keys and what they do. */
export type HelpLine =
    | { readonly kind: 'group'; readonly text: KeyGroup }
    | { readonly kind: 'key'; readonly keys: string; readonly help: string }
    | { readonly kind: 'note'; readonly text: string };

/** Every key, grouped, in the table's order within each group. */
export function helpLines(): HelpLine[] {
    return KEY_GROUPS.flatMap((group) => {
        const rows = KEY_TABLE.filter((r) => r.group === group);
        if (rows.length === 0) return [];
        return [
            { kind: 'group' as const, text: group },
            ...rows.map((r) => ({ kind: 'key' as const, keys: r.keys, help: r.help })),
        ];
    });
}

/** The keys column's width in the `?` overlay: the widest keys, then two spaces. */
export const HELP_KEYS_WIDTH = Math.max(...KEY_TABLE.map((r) => stringWidth(r.keys))) + 2;
