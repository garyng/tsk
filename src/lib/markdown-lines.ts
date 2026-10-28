import { marked, type Token, type Tokens } from 'marked';
import stringWidth from 'string-width';
import { TSK_REF } from './tsk-ref';
import { wrapSpans } from './tui-layout';

/**
 * A Markdown file as the detail pane's lines, pure: `marked`'s lexer for the
 * parsing, our own renderer from its tokens to styled, already-wrapped lines
 * (what Claude Code, glamour, rich and Codex all do: a parser
 * plus a renderer of their own, so the layout stays the app's). Each line
 * remembers the source line its block starts at, so the pane can open at the
 * line naming a task and `o` can open the editor where the reader is.
 */

/** What a piece of the detail pane is; the theme picks the style. */
export type DetailTone =
    | 'plain'
    | 'label'
    | 'heading'
    | 'strong'
    | 'em'
    | 'code'
    | 'link'
    | 'ref'
    | 'target'
    | 'quote'
    | 'rule'
    | 'muted'
    | 'marker'
    | 'done'
    | 'error';

export interface DetailSpan {
    readonly text: string;
    readonly tone: DetailTone;
}

export interface DetailLine {
    readonly spans: readonly DetailSpan[];
    /** The zero-based source line the block this line renders starts at, for a Markdown line. */
    readonly source?: number;
}

/** The first line naming `tsk:<id>`, zero-based. */
export function taskLineIn(md: string, id: string): number | undefined {
    const lines = md.split('\n');
    const i = lines.findIndex((l) => [...l.matchAll(TSK_REF)].some((m) => m[1] === id));
    return i >= 0 ? i : undefined;
}

/** The first rendered line of the block that holds `source` (the last block starting at or before it). */
export function anchorIndex(lines: readonly DetailLine[], source: number): number {
    let best: number | undefined;
    for (const l of lines) {
        if (l.source !== undefined && l.source <= source && (best === undefined || l.source > best))
            best = l.source;
    }
    const i = lines.findIndex((l) => l.source === best);
    return Math.max(0, i);
}

const ENTITIES: Readonly<Record<string, string>> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
};
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e] ?? e);

/** `text` in `tone`, with each `tsk:<id>` picked out — the selected task's own as the target. */
function refSpans(text: string, tone: DetailTone, target: string | undefined): DetailSpan[] {
    const out: DetailSpan[] = [];
    let at = 0;
    for (const m of text.matchAll(TSK_REF)) {
        if (m.index > at) out.push({ text: text.slice(at, m.index), tone });
        out.push({ text: m[0], tone: m[1] === target ? 'target' : 'ref' });
        at = m.index + m[0].length;
    }
    if (at < text.length) out.push({ text: text.slice(at), tone });
    return out;
}

/** Inline tokens as spans; a hard line break is a `\n` span, split on before wrapping. */
function inline(
    tokens: readonly Token[],
    tone: DetailTone,
    target: string | undefined,
): DetailSpan[] {
    const out: DetailSpan[] = [];
    for (const t of tokens) {
        switch (t.type) {
            case 'text':
            case 'escape': {
                const tt = t as Tokens.Text;
                if (tt.tokens && tt.tokens.length > 0) out.push(...inline(tt.tokens, tone, target));
                else out.push(...refSpans(decode(tt.text).replace(/\n/g, ' '), tone, target));
                break;
            }
            case 'strong':
                out.push(...inline((t as Tokens.Strong).tokens, 'strong', target));
                break;
            case 'em':
                out.push(...inline((t as Tokens.Em).tokens, 'em', target));
                break;
            case 'del':
                out.push(...inline((t as Tokens.Del).tokens, 'muted', target));
                break;
            case 'codespan':
                out.push(...refSpans(decode((t as Tokens.Codespan).text), 'code', target));
                break;
            case 'link':
                out.push(...inline((t as Tokens.Link).tokens, 'link', target));
                break;
            case 'image':
                out.push({ text: `[image: ${(t as Tokens.Image).text}]`, tone: 'muted' });
                break;
            case 'br':
                out.push({ text: '\n', tone });
                break;
            case 'html':
                if (!t.raw.startsWith('<!--')) out.push({ text: t.raw, tone: 'muted' });
                break;
            default:
                if ('text' in t && typeof t.text === 'string') out.push({ text: t.text, tone });
        }
    }
    return out;
}

const plainText = (spans: readonly DetailSpan[]) => spans.map((s) => s.text).join('');

interface Ctx {
    readonly target: string | undefined;
    readonly out: DetailLine[];
    /**
     * Where a token's raw text starts in the source: its line, and the offset
     * just past it. Searched forward from the last token placed, so tokens are
     * placed in document order; {@link Ctx.past} moves on once a token and
     * everything inside it are rendered.
     */
    locate(raw: string): { line: number; end: number };
    past(end: number): void;
}

/**
 * `spans` wrapped into lines `width` wide after `first` (the first line's
 * lead: a bullet, a quote bar) and `rest` (every later line's, as wide).
 */
function emit(
    ctx: Ctx,
    spans: readonly DetailSpan[],
    width: number,
    source: number,
    first: readonly DetailSpan[],
    rest: readonly DetailSpan[],
) {
    const leadWidth = stringWidth(plainText(first));
    const groups: DetailSpan[][] = [[]];
    for (const s of spans) {
        const parts = s.text.split('\n');
        parts.forEach((p, i) => {
            if (i > 0) groups.push([]);
            if (p !== '') groups.at(-1)?.push({ ...s, text: p });
        });
    }
    let firstLine = true;
    for (const group of groups) {
        for (const l of wrapSpans(group, Math.max(1, width - leadWidth))) {
            ctx.out.push({ spans: [...(firstLine ? first : rest), ...l.spans], source });
            firstLine = false;
        }
    }
}

const blank = (ctx: Ctx) => {
    const last = ctx.out.at(-1);
    if (last && last.spans.length > 0) ctx.out.push({ spans: [] });
};

/** Block tokens, each line led by `lead` (quote bars, list indentation). */
function blocks(ctx: Ctx, tokens: readonly Token[], width: number, lead: readonly DetailSpan[]) {
    const leadWidth = stringWidth(plainText(lead));
    for (const t of tokens) {
        const { line: source, end } = ctx.locate(t.raw);
        block(ctx, t, source, width, lead, leadWidth);
        ctx.past(end);
    }
}

function block(
    ctx: Ctx,
    t: Token,
    source: number,
    width: number,
    lead: readonly DetailSpan[],
    leadWidth: number,
) {
    switch (t.type) {
        case 'space':
            blank(ctx);
            break;
        case 'heading': {
            if (ctx.out.length > 0) blank(ctx);
            const h = t as Tokens.Heading;
            emit(ctx, inline(h.tokens, 'heading', ctx.target), width, source, lead, lead);
            break;
        }
        case 'paragraph':
        case 'text': {
            const p = t as Tokens.Paragraph | Tokens.Text;
            const spans = p.tokens
                ? inline(p.tokens, 'plain', ctx.target)
                : refSpans(decode(p.text), 'plain', ctx.target);
            emit(ctx, spans, width, source, lead, lead);
            break;
        }
        case 'list':
            list(ctx, t as Tokens.List, width, lead);
            break;
        case 'code': {
            const room = Math.max(1, width - leadWidth - 2);
            (t as Tokens.Code).text.split('\n').forEach((line, i) => {
                // Code keeps its indentation, so it's cut at the width rather than word-wrapped.
                const pieces =
                    line === '' ? [''] : (line.match(new RegExp(`.{1,${room}}`, 'gu')) ?? ['']);
                for (const piece of pieces) {
                    ctx.out.push({
                        spans: [...lead, { text: `  ${piece}`, tone: 'code' }],
                        source: source + 1 + i,
                    });
                }
            });
            break;
        }
        case 'blockquote':
            blocks(ctx, (t as Tokens.Blockquote).tokens, width, [
                ...lead,
                { text: '│ ', tone: 'quote' },
            ]);
            break;
        case 'hr':
            ctx.out.push({
                spans: [
                    ...lead,
                    { text: '─'.repeat(Math.max(1, width - leadWidth)), tone: 'rule' },
                ],
                source,
            });
            break;
        case 'table':
            table(ctx, t as Tokens.Table, width, lead, source);
            break;
        case 'html':
            if (!t.raw.trimStart().startsWith('<!--')) {
                emit(ctx, [{ text: t.raw.trim(), tone: 'muted' }], width, source, lead, lead);
            }
            break;
        default:
            break;
    }
}

function list(ctx: Ctx, l: Tokens.List, width: number, lead: readonly DetailSpan[]) {
    const start = typeof l.start === 'number' ? l.start : 1;
    l.items.forEach((item, i) => {
        const { line: source, end } = ctx.locate(item.raw);
        const bullet = l.ordered ? `${start + i}. ` : '• ';
        const box = item.task ? (item.checked ? '✓ ' : '○ ') : '';
        const mark: DetailSpan[] = [
            { text: bullet, tone: 'muted' },
            ...(box
                ? [{ text: box, tone: item.checked ? ('done' as const) : ('muted' as const) }]
                : []),
        ];
        const hang: DetailSpan = { text: ' '.repeat(stringWidth(bullet + box)), tone: 'plain' };
        let first = true;
        for (const t of item.tokens) {
            if (t.type === 'checkbox') continue;
            if (first && (t.type === 'text' || t.type === 'paragraph')) {
                const p = t as Tokens.Text;
                const spans = p.tokens
                    ? inline(p.tokens, 'plain', ctx.target)
                    : refSpans(decode(p.text), 'plain', ctx.target);
                emit(ctx, spans, width, source, [...lead, ...mark], [...lead, hang]);
            } else {
                if (first) ctx.out.push({ spans: [...lead, ...mark], source });
                blocks(ctx, [t], width, [...lead, hang]);
            }
            first = false;
        }
        if (first) ctx.out.push({ spans: [...lead, ...mark], source });
        ctx.past(end);
    });
}

/** Aligned columns when they fit, else each row as one wrapped line. */
function table(
    ctx: Ctx,
    t: Tokens.Table,
    width: number,
    lead: readonly DetailSpan[],
    source: number,
) {
    const cell = (c: Tokens.TableCell, tone: DetailTone) => inline(c.tokens, tone, ctx.target);
    const rows = [
        t.header.map((c) => cell(c, 'strong')),
        ...t.rows.map((r) => r.map((c) => cell(c, 'plain'))),
    ];
    const room = width - stringWidth(plainText(lead));
    const widths = t.header.map((_, i) =>
        Math.max(...rows.map((r) => stringWidth(plainText(r[i] ?? [])))),
    );
    const sep: DetailSpan = { text: ' │ ', tone: 'muted' };
    const fits = widths.reduce((a, b) => a + b, 0) + sep.text.length * (widths.length - 1) <= room;
    rows.forEach((r, ri) => {
        const at = source + (ri === 0 ? 0 : ri + 1);
        if (fits) {
            const spans = r.flatMap((c, i) => [
                ...(i > 0 ? [sep] : []),
                ...c,
                {
                    text: ' '.repeat((widths[i] ?? 0) - stringWidth(plainText(c))),
                    tone: 'plain' as const,
                },
            ]);
            ctx.out.push({ spans: [...lead, ...spans], source: at });
        } else {
            emit(
                ctx,
                r.flatMap((c, i) => [...(i > 0 ? [sep] : []), ...c]),
                width,
                at,
                lead,
                lead,
            );
        }
        if (ri === 0 && fits) {
            const rule = widths.map((w) => '─'.repeat(w)).join('─┼─');
            ctx.out.push({ spans: [...lead, { text: rule, tone: 'rule' }], source: at });
        }
    });
}

/** `md` rendered `width` columns wide; `target` is the selected task's id, picked out where it's named. */
export function markdownLines(md: string, width: number, target?: string): DetailLine[] {
    const starts = [0];
    for (let i = 0; i < md.length; i++) if (md[i] === '\n') starts.push(i + 1);
    const lineOf = (offset: number) => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if ((starts[mid] ?? 0) <= offset) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    };
    let pos = 0;
    const ctx: Ctx = {
        target,
        out: [],
        locate(raw) {
            const at = raw === '' ? -1 : md.indexOf(raw, pos);
            const start = at >= 0 ? at : pos;
            return { line: lineOf(start), end: start + (at >= 0 ? raw.length : 0) };
        },
        past(end) {
            pos = Math.max(pos, end);
        },
    };
    blocks(ctx, marked.lexer(md), Math.max(4, width), []);
    while (ctx.out.at(-1)?.spans.length === 0) ctx.out.pop();
    return ctx.out;
}
