import type { DetailTone } from '../lib/markdown-lines';
import { MARKERS, type Marker } from '../lib/markers';
import type { Tone } from '../lib/tui-layout';

/**
 * The TUI's look, picked from mock-ups of reference designs:
 * the state is the glyph's shape and colour goes only where it matters, in
 * the extension's own marker colours (`markers.ts`, light or dark to match
 * the terminal); the selected row is a tint of the accent mixed into the
 * terminal's real background (`terminal-background.ts`), its text undimmed
 * and bold, so a finished task stays readable under it.
 *
 * Without colour (`NO_COLOR`, https://no-color.org) only bold, dim,
 * underline, strikethrough and inverse are used, and the selection is
 * inverse. Ink's chalk doesn't read `NO_COLOR` itself, so the caller decides.
 */

export interface Style {
    readonly color?: string;
    readonly backgroundColor?: string;
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly dimColor?: boolean;
    readonly underline?: boolean;
    readonly strikethrough?: boolean;
    readonly inverse?: boolean;
}

export interface Theme {
    readonly color: boolean;
    /** The state glyph. */
    readonly glyph: Readonly<Record<Marker, Style>>;
    /** A task's text by its state: finished ones recede. */
    readonly text: Readonly<Record<Marker, Style>>;
    readonly tone: Readonly<Record<Exclude<Tone, 'marker'>, Style>>;
    /** The selected row's box (its tint), and what's laid over every piece of it. */
    readonly selectedRow: Style;
    readonly selected: Style;
    /** The cursor in the footer's list of states: the selection, as the bar's own grey would hide it. */
    readonly cursor: Style;
    /** The tab strip: the app's name, a tab, the active one, and the rule under them. */
    readonly name: Style;
    readonly tab: Style;
    readonly activeTab: Style;
    readonly rule: Style;
    /** The footer bar, a key in it, and a key's label. */
    readonly bar: Style;
    readonly key: Style;
    /** A message in the footer bar: a confirmation, and an error. */
    readonly ok: Style;
    readonly error: Style;
    readonly dim: Style;
    /** The detail pane: the task's facts and the rendered Markdown. */
    readonly detail: Readonly<Record<DetailTone, Style>>;
}

export interface Backdrop {
    /** The terminal's background, `#rrggbb`, when it said. */
    readonly background?: string;
    /** Light or dark: from the background, else `COLORFGBG`, else dark. */
    readonly dark: boolean;
}

/** Assumed when the terminal doesn't say: VS Code's terminal background, and white. */
const DEFAULT_BACKGROUND = { dark: '#1e1e1e', light: '#ffffff' };
/** VS Code's warning yellow for `◀N`, and a cyan for `#tags`, each muted toward the background below. */
const WARNING = { dark: '#cca700', light: '#bf8803' };
const CYAN = { dark: '#29b8db', light: '#0598bc' };
/** VS Code's `editorError.foreground`. */
const ERROR = { dark: '#f14c4c', light: '#e51400' };

const DIM: Style = { dimColor: true };

/**
 * `a` mixed `t` of the way into `b`, both `#rrggbb` — a plain sRGB mix, as
 * Gemini CLI's 20% selection tint is. A colour library (culori, chroma-js) is
 * far more than these few lines need.
 */
export function mix(a: string, b: string, t: number): string {
    const rgb = (c: string) => {
        const n = Number.parseInt(c.slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const B = rgb(b);
    return `#${rgb(a)
        .map((v, i) => Math.round(v * t + (B[i] ?? 0) * (1 - t)))
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('')}`;
}

export function makeTheme(color: boolean, backdrop: Backdrop = { dark: true }): Theme {
    const shade = backdrop.dark ? 'dark' : 'light';
    const bg = backdrop.background ?? DEFAULT_BACKGROUND[shade];
    const ext = Object.fromEntries(MARKERS.map((m) => [m.name, m.color[shade]])) as Record<
        Marker,
        string
    >;
    const accent = ext.inprogress;
    const c = (value: string): Style => (color ? { color: value } : {});
    /** Raised surfaces (the active tab, the footer bar) and the faint lines (rule, tree lines). */
    const ink = backdrop.dark ? '#ffffff' : '#000000';
    const raised = mix(ink, bg, backdrop.dark ? 0.08 : 0.06);
    const faint = mix(ink, bg, backdrop.dark ? 0.24 : 0.22);
    const selectedRow: Style = color ? { backgroundColor: mix(accent, bg, 0.2) } : {};
    const selected: Style = color
        ? { bold: true, dimColor: false }
        : { inverse: true, dimColor: false };
    return {
        color,
        glyph: {
            todo: {},
            inprogress: { ...c(accent), bold: true },
            completed: c(ext.completed),
            cancelled: c(ext.cancelled),
            moved: c(ext.cancelled),
            notes: DIM,
        },
        text: {
            todo: {},
            inprogress: { bold: true },
            completed: DIM,
            cancelled: { dimColor: true, strikethrough: true },
            moved: DIM,
            notes: DIM,
        },
        tone: {
            plain: {},
            gutter: {},
            guide: color ? { color: faint } : DIM,
            tag: color ? { color: mix(CYAN[shade], bg, 0.8) } : {},
            link: { dimColor: true, underline: true },
            note: DIM,
            focus: { ...c(accent), bold: true },
            depth: DIM,
            chain: DIM,
            waits: color ? { color: WARNING[shade] } : { bold: true },
            needed: DIM,
            folded: DIM,
            // Not dim, as `+N` is: the fold is what it's there to show.
            fold: { ...c(accent), bold: true },
            marked: { ...c(accent), bold: true },
            // The filter's terms: underlined too, to read on the selection's tint.
            match: { ...c(accent), bold: true, underline: true },
        },
        selectedRow,
        selected,
        cursor: { ...selectedRow, ...selected },
        name: { bold: true },
        tab: DIM,
        activeTab: color
            ? { bold: true, backgroundColor: raised }
            : { bold: true, underline: true },
        rule: color ? { color: faint } : DIM,
        bar: color ? { backgroundColor: raised } : {},
        key: { ...c(accent), bold: true },
        ok: c(ext.completed),
        error: color ? { color: ERROR[shade] } : { bold: true },
        dim: DIM,
        detail: {
            plain: {},
            label: DIM,
            heading: { ...c(accent), bold: true },
            strong: { bold: true },
            em: { italic: true },
            code: DIM,
            link: { underline: true },
            ref: c(accent),
            target: { ...c(accent), bold: true, underline: true },
            quote: DIM,
            rule: color ? { color: faint } : DIM,
            muted: DIM,
            marker: {},
            done: c(ext.completed),
            error: color ? { color: ERROR[shade] } : { bold: true },
        },
    };
}
