import { posix } from 'node:path';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import type { Marker } from './markers';
import { tagSpans } from './tag-span';
import { idMatchLength, type TextRange, termRanges } from './tui-filter';
import { HELP_KEYS_WIDTH, type HelpLine } from './tui-keys';
import { indentFor, type TaskLine, type TuiLine } from './tui-view-model';
import { type WikiLinkSpan, wikiLinkSpans } from './wiki-link';

/**
 * Where the `tsk` TUI's rows go on screen, pure. A task row is a fixed-width
 * prefix — the focus gutter, tree lines, the state glyph — beside its text
 * and badges, which wrap under themselves (a hanging indent) instead of being cut
 * with `…`. The text is wrapped here, not by Ink: Ink keeps the space at a
 * break (`trim: false`), which starts the next line one column in. Rows
 * therefore differ in height, and the list is windowed in screen lines
 * ({@link listWindow}).
 */

/** What a piece of a row is; the renderer picks the style. */
export type Tone =
    | 'plain'
    | 'guide'
    | 'tag'
    | 'link'
    | 'note'
    | 'gutter'
    | 'focus'
    | 'depth'
    | 'chain'
    | 'marker'
    | 'waits'
    | 'needed'
    | 'folded'
    | 'fold'
    | 'marked'
    | 'match';

export interface Span {
    readonly text: string;
    readonly tone: Tone;
}

export interface TaskRow {
    readonly prefix: readonly Span[];
    /** The prefix of each wrapped line after the first: the tree lines carry on, nothing else. */
    readonly continuation: readonly Span[];
    readonly prefixWidth: number;
    /** The task's text — `#tags`, and each `[[link]]` as its file name and heading — then its badges and the dim note, wrapped. */
    readonly lines: readonly WrappedLine[];
}

/** One screen line of wrapped text, where it starts in the text (a stable key), and its width. */
export interface WrappedLine {
    readonly start: number;
    readonly spans: readonly Span[];
    readonly width: number;
}

/**
 * A task's state is the glyph's shape, so it reads without colour (Linear,
 * org-modern, render-markdown.nvim): open, half done, done, crossed out,
 * moved on. All one column wide, and none has an emoji form.
 */
export const STATE_GLYPH: Readonly<Record<Marker, string>> = {
    todo: '○',
    inprogress: '◐',
    completed: '✓',
    cancelled: '✕',
    moved: '→',
    notes: '•',
};

/** A row starts with a one-column gutter for the session's focus; the selection is the row's background. */
export const FOCUS_MARK = '◆';
/** In the gutter of a task marked for the next message, over the focus's mark while it's marked. */
export const MARKED_MARK = '●';
export const GUTTER_WIDTH = 1;
/**
 * The dependency badges, `◀N` "waits on N" and `▶N` "N wait on it": the
 * shapes of the extension's dependsOn / dependents lenses (`CODICONS` in
 * `codelens-logic.ts`), one column each. Not emoji: one with a variation
 * selector (`➡️`) is one column to some terminals and tmux and two to others,
 * which shifts the rest of the row.
 */
export const WAITS_MARK = '◀';
export const UNBLOCKS_MARK = '▶';
/** A folded row's badge, `+N`: the tasks out of view under it. */
export const FOLDED_MARK = '+';
/** Right before a folded row's state glyph, as Finder's and VS Code's trees mark a closed one. Unlike the chain's `›`. */
export const FOLD_MARK = '▸';

/**
 * Put `▸` in the space just before the state glyph (`│▸✓`),
 * so a folded row's text lines up with the rows beside it. Where the gutter's
 * `◆` or `●` comes right before the glyph, there's no space, and `▸` goes
 * between them.
 */
function foldInto(prefix: Span[]): void {
    let at = prefix.length - 1;
    while (at > 0 && prefix[at]?.text === '') at--;
    const last = prefix[at];
    if (last?.text.endsWith(' ')) {
        prefix.splice(
            at,
            1,
            { ...last, text: last.text.slice(0, -1) },
            { text: FOLD_MARK, tone: 'fold' },
        );
    } else prefix.push({ text: FOLD_MARK, tone: 'fold' });
}

/**
 * `terms`: the filter's, highlighted where they occur in the text of a task
 * that matches it; when one is found only at the start of the task's `@id`,
 * the id follows the text, that much of it highlighted.
 */
export function taskRow(
    line: TaskLine,
    width: number,
    terms: readonly string[] = [],
    headingOf?: HeadingOf,
    marked = false,
): TaskRow {
    const { node, depth, chained, focus, note, waits, needed, folded, context, lasts } = line;
    const { columns, badge } = indentFor(depth, width - GUTTER_WIDTH);
    const indent = (wrapped: boolean): Span =>
        lasts
            ? { text: guideText(lasts, columns / 2, wrapped), tone: 'guide' }
            : { text: ' '.repeat(columns), tone: 'plain' };
    const prefix: Span[] = [
        marked
            ? { text: MARKED_MARK, tone: 'marked' }
            : { text: focus ? FOCUS_MARK : ' ', tone: focus ? 'focus' : 'gutter' },
        indent(false),
    ];
    if (badge) prefix.push({ text: `${badge} `, tone: 'depth' });
    if (chained) prefix.push({ text: '› ', tone: 'chain' });
    if (folded) foldInto(prefix);
    prefix.push({ text: `${STATE_GLYPH[node.task.marker]} `, tone: 'marker' });
    const prefixWidth = widthOf(prefix);
    const lead = indent(true);
    const continuation: Span[] = [
        { text: ' ', tone: 'gutter' },
        lead,
        { text: ' '.repeat(prefixWidth - GUTTER_WIDTH - stringWidth(lead.text)), tone: 'plain' },
    ];
    const shown = contentSpans(node.task.content, headingOf);
    const filtered = terms.length > 0 && !context;
    const text = filtered ? markRanges(shown, termRanges(rowText(shown), terms)) : shown;
    const byId = filtered && node.id ? idMatchLength(rowText(shown), node.id, terms) : 0;
    if (node.id && byId > 0) {
        text.push(
            { text: '  ', tone: 'plain' },
            { text: node.id.slice(0, byId), tone: 'match' },
            { text: node.id.slice(byId), tone: 'note' },
        );
    }
    if (folded)
        text.push(
            { text: '  ', tone: 'plain' },
            { text: `${FOLDED_MARK}${folded}`, tone: 'folded' },
        );
    if (waits > 0)
        text.push({ text: '  ', tone: 'plain' }, { text: `${WAITS_MARK}${waits}`, tone: 'waits' });
    if (needed > 0) {
        text.push(
            { text: '  ', tone: 'plain' },
            { text: `${UNBLOCKS_MARK}${needed}`, tone: 'needed' },
        );
    }
    if (note) text.push({ text: `  ${note}`, tone: 'note' });
    return { prefix, continuation, prefixWidth, lines: wrapSpans(text, width - prefixWidth) };
}

/**
 * Tree lines for `levels` levels, two columns each (neo-tree): `│` where the
 * task above at that level has siblings still to come, `└` before the last
 * child, blank past it; a wrapped line carries the `│`s on. `lasts[k]` says
 * whether the task at depth `k + 1` on this row's path is its parent's last
 * child (the row itself at the end). Past the depth cap only the shallowest
 * levels are drawn and the row's own comes last.
 */
export function guideText(lasts: readonly boolean[], levels: number, wrapped: boolean): string {
    if (levels <= 0) return '';
    const above = lasts.slice(0, levels - 1).map((last) => (last ? '  ' : '│ '));
    const own = lasts.at(-1) ?? true;
    return [...above, own ? (wrapped ? '  ' : '└ ') : '│ '].join('');
}

/**
 * `spans` wrapped at word boundaries into lines of at most `width` columns
 * (a word longer than that is split), the spaces at each break dropped, each
 * span keeping its tone across the break.
 */
export function wrapSpans<S extends Styled = Span>(
    spans: readonly S[],
    width: number,
): { start: number; spans: S[]; width: number }[] {
    const text = spans.map((s) => s.text).join('');
    const wrapped = wrapAnsi(text, Math.max(1, width), { trim: true, hard: true }).split('\n');
    const out: { start: number; spans: S[]; width: number }[] = [];
    let at = 0;
    for (const line of wrapped) {
        // wrap-ansi only drops spaces and inserts breaks, so each line is found in order.
        const start = line === '' ? at : text.indexOf(line, at);
        at = start + line.length;
        out.push({ start, spans: sliceSpans(spans, start, at), width: stringWidth(line) });
    }
    return out;
}

/** Anything wrapped as styled pieces: a row's spans, or the detail pane's. */
export interface Styled {
    readonly text: string;
}

function sliceSpans<S extends Styled>(spans: readonly S[], from: number, to: number): S[] {
    const out: S[] = [];
    let at = 0;
    for (const s of spans) {
        const a = Math.max(from, at);
        const b = Math.min(to, at + s.text.length);
        if (a < b) out.push({ ...s, text: s.text.slice(a - at, b - at) });
        at += s.text.length;
    }
    return out;
}

/** The text of the heading a `[[path#fragment]]` names, when the linked file has it. */
export type HeadingOf = (path: string, fragment: string) => string | undefined;

/** A `[[link]]` as a row shows it: the file's name, then the heading it names (the fragment as written when that isn't found). */
function linkText(link: WikiLinkSpan, headingOf: HeadingOf | undefined): string {
    const name = posix.basename(link.path);
    if (link.fragment === undefined) return name;
    const heading = headingOf?.(link.path, link.fragment);
    return heading ? `${name} › ${heading}` : `${name}#${link.fragment}`;
}

/** A task's text in pieces: `#tags`, `[[links]]` shown by {@link linkText}, the rest plain. */
export function contentSpans(content: string, headingOf?: HeadingOf): Span[] {
    const marks = [
        ...tagSpans(content).map((s) => ({
            ...s,
            span: { text: `#${s.tag}`, tone: 'tag' as const },
        })),
        ...wikiLinkSpans(content).map((s) => ({
            ...s,
            span: { text: linkText(s, headingOf), tone: 'link' as const },
        })),
    ].sort((a, b) => a.startCol - b.startCol);
    const out: Span[] = [];
    let at = 0;
    for (const m of marks) {
        if (m.startCol < at) continue;
        if (m.startCol > at) out.push({ text: content.slice(at, m.startCol), tone: 'plain' });
        out.push(m.span);
        at = m.endCol;
    }
    if (at < content.length) out.push({ text: content.slice(at), tone: 'plain' });
    return out;
}

/** The text a row shows for a task: what the filter matches against. */
export function rowText(spans: readonly Span[]): string {
    return spans.map((s) => s.text).join('');
}

/** `spans` with what `ranges` cover (sorted, apart, in the joined text) split out as `match`. */
export function markRanges(spans: readonly Span[], ranges: readonly TextRange[]): Span[] {
    const out: Span[] = [];
    let at = 0;
    for (const s of spans) {
        const end = at + s.text.length;
        let from = at;
        for (const r of ranges) {
            const a = Math.max(r.start, from);
            const b = Math.min(r.end, end);
            if (a >= b) continue;
            if (a > from) out.push({ text: s.text.slice(from - at, a - at), tone: s.tone });
            out.push({ text: s.text.slice(a - at, b - at), tone: 'match' });
            from = b;
        }
        if (from < end) out.push({ text: s.text.slice(from - at), tone: s.tone });
        at = end;
    }
    return out;
}

/** A heading as a rule, `── text ───…` across the width when it fits on one line. */
export function headingText(text: string, width: number): string {
    const head = `── ${text} `;
    const room = width - stringWidth(head);
    return room > 0 ? head + '─'.repeat(room) : head.trimEnd();
}

/** A row of the `?` overlay on screen: the keys column (blank under a wrapped help), then the text. */
export interface HelpRow {
    /** Unique in the overlay. */
    readonly id: string;
    readonly kind: HelpLine['kind'];
    readonly keys: string;
    readonly text: string;
}

/**
 * The `?` overlay in rows `width` columns wide: a key's help wraps under its
 * own text, past the keys column, as a man page's options do.
 */
export function helpRows(items: readonly HelpLine[], width: number): HelpRow[] {
    const wrap = (text: string, w: number) =>
        wrapAnsi(text, Math.max(1, w), { trim: true, hard: true }).split('\n');
    const blank = ' '.repeat(HELP_KEYS_WIDTH);
    return items.flatMap((item): HelpRow[] => {
        if (item.kind === 'key')
            return wrap(item.help, width - HELP_KEYS_WIDTH).map((text, i) => ({
                id: `key ${item.keys} ${i}`,
                kind: 'key',
                keys: i === 0 ? item.keys + blank.slice(stringWidth(item.keys)) : blank,
                text,
            }));
        const lines =
            item.kind === 'group' ? headingLines(item.text, width) : wrap(item.text, width);
        return lines.map((text, i) => ({
            id: `${item.kind} ${item.text} ${i}`,
            kind: item.kind,
            keys: '',
            text,
        }));
    });
}

/** A heading's rule, wrapped if the text is wider than the pane. */
export function headingLines(text: string, width: number): string[] {
    return wrapAnsi(headingText(text, width), Math.max(1, width), { trim: true, hard: true }).split(
        '\n',
    );
}

/** The screen lines a row takes at `width`, with the filter's `terms` (an id can follow the text). */
export function lineHeight(
    line: TuiLine,
    width: number,
    terms: readonly string[] = [],
    headingOf?: HeadingOf,
): number {
    if (line.kind === 'crumbs') return 1;
    if (line.kind === 'heading') return headingLines(line.text, width).length;
    return taskRow(line, width, terms, headingOf).lines.length;
}

function widthOf(spans: readonly Span[]): number {
    return spans.reduce((w, s) => w + stringWidth(s.text), 0);
}

export interface ListWindow {
    /** The first row shown. */
    readonly top: number;
    /** Past the last row shown. */
    readonly end: number;
    /** Rows above and below the window, each marked with a one-line `↑ N more` / `↓ N more`. */
    readonly above: number;
    readonly below: number;
}

/**
 * Which rows fit in `height` screen lines: starting from `prevTop`, scrolled
 * just enough that the selected row and `margin` rows either side of it are
 * in view (vim's `scrolloff`), or as many as fit — the view stays put while
 * the selection moves inside it. A line is kept for `↑ N more` when rows are hidden above and for
 * `↓ N more` when rows are hidden below. A row taller than the whole window
 * is shown alone, clipped.
 */
export function listWindow(
    heights: readonly number[],
    selected: number,
    prevTop: number,
    height: number,
    margin = 2,
): ListWindow {
    const n = heights.length;
    if (n === 0) return { top: 0, end: 0, above: 0, below: 0 };
    const sel = Math.max(0, Math.min(selected, n - 1));
    const endFrom = (top: number) => fitFrom(heights, top, height);
    // The widest margin that fits: tall wrapped rows may leave room for less.
    let top = 0;
    for (let m = Math.max(0, margin); m >= 0; m--) {
        top = Math.max(0, Math.min(prevTop, n - 1, sel - m));
        const last = Math.min(n - 1, sel + m);
        while (top < sel - m && endFrom(top) <= last) top++;
        if (endFrom(top) > last) break;
    }
    return windowAt(heights, top, height);
}

/**
 * The window from `top` as it stands, not following the selection: the
 * wheel's view, which leaves the selection where it is, even out of sight.
 */
export function viewWindow(heights: readonly number[], top: number, height: number): ListWindow {
    if (heights.length === 0) return { top: 0, end: 0, above: 0, below: 0 };
    return windowAt(heights, Math.max(0, Math.min(top, heights.length - 1)), height);
}

/**
 * `top` moved by about `lines` screen lines (negative: up) in whole rows —
 * at least one, and as many as it takes for the rows passed to add up to
 * `lines` — within the list. {@link viewWindow} then pulls it back from the end.
 */
export function scrollRows(heights: readonly number[], top: number, lines: number): number {
    const step = Math.sign(lines);
    let at = top;
    let moved = 0;
    while (moved < Math.abs(lines)) {
        const next = at + step;
        if (next < 0 || next >= heights.length) break;
        moved += heights[step > 0 ? at : next] ?? 1;
        at = next;
    }
    return at;
}

/** Past the last row that fits from `top`, after the "more" lines. */
function fitFrom(heights: readonly number[], top: number, height: number): number {
    const n = heights.length;
    const room = height - (top > 0 ? 1 : 0);
    let used = 0;
    let end = top;
    while (end < n && used + (heights[end] ?? 1) <= room) used += heights[end++] ?? 1;
    if (end < n) {
        while (end > top && used + 1 > room) used -= heights[--end] ?? 1;
    }
    return Math.max(end, top + 1);
}

/** The window from `from`, pulled back so rows above fill what would be blank lines at the bottom. */
function windowAt(heights: readonly number[], from: number, height: number): ListWindow {
    const n = heights.length;
    let top = from;
    while (top > 0 && fitFrom(heights, top - 1, height) === n) top--;
    const end = fitFrom(heights, top, height);
    return { top, end, above: top, below: n - end };
}
