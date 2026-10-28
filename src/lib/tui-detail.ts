import path from 'node:path';
import { blockers, dependents } from './dependencies';
import { type DetailLine, type DetailSpan, type DetailTone, taskLineIn } from './markdown-lines';
import type { Marker } from './markers';
import { agentOf, isOpen, sessionOf, shortSessionId } from './session-focus';
import { outsideFileOf, pathTo, type TaskTree, type TreeNode } from './task-tree';
import { contentSpans, type HeadingOf, STATE_GLYPH, wrapSpans } from './tui-layout';
import { shortTitle } from './tui-view-model';
import { wikiLinkSpans } from './wiki-link';

/**
 * The TUI's detail pane, pure: the selected task's facts, the
 * file its plan lives in, and how the screen splits between the list and the
 * pane. The Markdown itself is `markdown-lines.ts`.
 */

const STATE_NAME: Readonly<Record<Marker, string>> = {
    todo: 'todo',
    inprogress: 'in progress',
    completed: 'done',
    cancelled: 'cancelled',
    moved: 'moved',
    notes: 'note',
};

/** The stamps a task can carry, in the order they happen. */
const TIME_KEYS = ['created', 'started', 'focused', 'completed', 'cancelled', 'moved'] as const;

export interface TaskFacts {
    readonly id: string | undefined;
    readonly marker: Marker;
    readonly content: string;
    /** Each stamp the task has, as `YYYY-MM-DD HH:MM`. */
    readonly times: readonly { readonly key: string; readonly at: string }[];
    readonly session: string | undefined;
    /** The agent it was handed to (`tsk delegate`). */
    readonly agent: string | undefined;
    /** The short titles of the tasks it sits in, outermost first. */
    readonly path: readonly string[];
    /** What still holds it back: its own open dependencies, and those of the tasks it sits in. */
    readonly waitsOn: readonly {
        readonly id: string;
        readonly title?: string;
        readonly through?: string;
    }[];
    /** The open tasks that wait on it. */
    readonly neededBy: readonly { readonly id?: string; readonly title: string }[];
    readonly children: { readonly open: number; readonly finished: number };
}

const shortStamp = (v: string) => {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(v);
    return m ? `${m[1]} ${m[2]}` : v;
};

export function taskFacts(tree: TaskTree, node: TreeNode): TaskFacts {
    const meta = node.task.metadata;
    const session = sessionOf(node);
    return {
        id: node.id,
        marker: node.task.marker,
        content: node.task.content,
        times: TIME_KEYS.flatMap((key) => {
            const v = meta.get(key);
            return v ? [{ key, at: shortStamp(v) }] : [];
        }),
        session: session ? shortSessionId(session) : undefined,
        agent: agentOf(node),
        // A task from a file beside the tree's own sits in that file first.
        path: [
            ...[outsideFileOf(tree, node)].flatMap((f) => (f ? [path.basename(f)] : [])),
            ...pathTo(node)
                .slice(0, -1)
                .map((n) => shortTitle(n.task.content)),
        ],
        // A finished task waits on nothing, whatever it or the tasks above it still name.
        waitsOn: (isOpen(node.task.marker) ? blockers(tree, node) : []).map((b) => ({
            id: b.id,
            title: b.node ? shortTitle(b.node.task.content) : undefined,
            through: b.via === node ? undefined : shortTitle(b.via.task.content),
        })),
        neededBy: dependents(tree, node)
            .filter((d) => isOpen(d.task.marker))
            .map((d) => ({ id: d.id, title: shortTitle(d.task.content) })),
        children: {
            open: node.children.filter((c) => isOpen(c.task.marker)).length,
            finished: node.children.filter((c) => !isOpen(c.task.marker)).length,
        },
    };
}

/** The facts as the pane's lines, `width` wide: state and id, the full text, then whatever applies. */
export function factLines(facts: TaskFacts, width: number, headingOf?: HeadingOf): DetailLine[] {
    const out: DetailLine[] = [];
    const add = (spans: readonly DetailSpan[]) => {
        for (const l of wrapSpans(spans, Math.max(1, width))) out.push({ spans: l.spans });
    };
    const label = (text: string): DetailSpan => ({ text, tone: 'label' });
    const plain = (text: string): DetailSpan => ({ text, tone: 'plain' });
    const joined = (items: readonly DetailSpan[][]) =>
        items.flatMap((spans, i) => [...(i > 0 ? [label(' · ')] : []), ...spans]);

    add([
        { text: `${STATE_GLYPH[facts.marker]} ${STATE_NAME[facts.marker]}`, tone: 'marker' },
        ...(facts.id ? [label(' · '), { text: facts.id, tone: 'ref' as const }] : []),
    ]);
    const tone = (t: 'plain' | 'tag' | 'link' | string): DetailTone =>
        t === 'tag' ? 'muted' : t === 'link' ? 'link' : 'plain';
    add(contentSpans(facts.content, headingOf).map((s) => ({ text: s.text, tone: tone(s.tone) })));
    const when = [
        ...facts.times.map((t) => [label(`${t.key} `), plain(t.at)]),
        ...(facts.session ? [[label('session '), plain(facts.session)]] : []),
        ...(facts.agent ? [[label('agent '), plain(facts.agent)]] : []),
    ];
    if (when.length > 0) add(joined(when));
    if (facts.path.length > 0) add([label('in '), plain(facts.path.join(' › '))]);
    if (facts.waitsOn.length > 0) {
        add([
            label('waits on '),
            ...joined(
                facts.waitsOn.map((w) => [
                    { text: w.id, tone: 'ref' },
                    plain(w.title ? ` ${w.title}` : ' (not in any file)'),
                    ...(w.through ? [label(` through ${w.through}`)] : []),
                ]),
            ),
        ]);
    }
    if (facts.neededBy.length > 0) {
        add([
            label('needed by '),
            ...joined(
                facts.neededBy.map((n) => [
                    ...(n.id ? [{ text: `${n.id} `, tone: 'ref' as const }] : []),
                    plain(n.title),
                ]),
            ),
        ]);
    }
    const { open, finished } = facts.children;
    if (open + finished > 0) {
        add([label('children '), plain(`${open} open · ${finished} finished`)]);
    }
    return out;
}

/**
 * The file the pane shows for `node`: its own first `[[link]]`, else its
 * nearest linked ancestor's — a plan's sub-step shows the plan.
 */
export function linkedFile(node: TreeNode): { path: string; from: TreeNode } | undefined {
    for (const n of pathTo(node).reverse()) {
        const link = wikiLinkSpans(n.task.content)[0];
        if (link) return { path: link.path, from: n };
    }
    return undefined;
}

/** Side by side from this many columns; below it the pane sits under the list. */
export const SIDE_BY_SIDE_FROM = 100;
/** The pane's share of the height (stacked) or of the width (side by side), until resized. */
export const DETAIL_SHARE = 0.4;
/** What `+` / `-` move the pane by: this much of its axis, at least a line or a column. */
export const SHARE_STEP = 0.05;
/** Hidden unless asked for in a terminal shorter than this. */
export const AUTO_HIDE_BELOW = 24;
/** Neither the list nor the pane gets fewer lines than this; below it the pane stays hidden. */
const MIN_ROWS = 3;
/** Nor fewer columns than this side by side. */
export const MIN_COLS = 20;

export interface PaneSplit {
    readonly shown: boolean;
    readonly side: boolean;
    readonly listWidth: number;
    readonly listRows: number;
    readonly detailWidth: number;
    readonly detailRows: number;
}

/** The pane's size along its axis, kept to the limits: `total` is the width beside, the height stacked. */
function clampSize(size: number, side: boolean, total: number): number {
    const min = side ? MIN_COLS : MIN_ROWS;
    return Math.max(min, Math.min(size, total - min));
}

/**
 * How `width` × `rows` (the space between the tab strip and the footer)
 * divides: `wanted` is the `p` toggle, `undefined` until pressed, which shows
 * the pane in a terminal at least {@link AUTO_HIDE_BELOW} tall; `share` is
 * the pane's part of its axis, kept to the limits.
 */
export function splitPane(
    width: number,
    rows: number,
    terminalRows: number,
    wanted: boolean | undefined,
    share = DETAIL_SHARE,
): PaneSplit {
    const none = {
        shown: false,
        side: false,
        listWidth: width,
        listRows: rows,
        detailWidth: 0,
        detailRows: 0,
    };
    if (!(wanted ?? terminalRows >= AUTO_HIDE_BELOW)) return none;
    if (width >= SIDE_BY_SIDE_FROM) {
        // One column of the pane's width is its left border.
        const detailWidth = clampSize(Math.round(width * share), true, width);
        return {
            shown: true,
            side: true,
            listWidth: width - detailWidth,
            listRows: rows,
            detailWidth,
            detailRows: rows,
        };
    }
    if (rows < 2 * MIN_ROWS) return none;
    const detailRows = clampSize(Math.round(rows * share), false, rows);
    return {
        shown: true,
        side: false,
        listWidth: width,
        listRows: rows - detailRows,
        detailWidth: width,
        detailRows,
    };
}

/**
 * The share after a `+` (`1`) or a `-` (`-1`): from the size the pane has
 * now, not the share asked for, so a step back from a limit always shows.
 */
export function stepShare(split: PaneSplit, width: number, rows: number, dir: 1 | -1): number {
    const total = split.side ? width : rows;
    const size = split.side ? split.detailWidth : split.detailRows;
    const step = Math.max(1, Math.round(total * SHARE_STEP));
    return clampSize(size + dir * step, split.side, total) / total;
}

/**
 * The share that puts the pane's edge under a dragging pointer: beside the
 * list, its `│` border on column `x`; stacked, its top rule on line `y` of
 * the space {@link splitPane} divides.
 */
export function shareAt(side: boolean, width: number, rows: number, x: number, y: number): number {
    return side
        ? clampSize(width - x, true, width) / width
        : clampSize(rows - y, false, rows) / rows;
}

/**
 * The first line of `md` naming `node` as `tsk:<id>` — or, when the plan
 * doesn't name it, its nearest ancestor that it does: a sidetrack opens at
 * the step it came out of.
 */
export function namedLine(md: string, node: TreeNode): number | undefined {
    for (const n of pathTo(node).reverse()) {
        const line = n.id ? taskLineIn(md, n.id) : undefined;
        if (line !== undefined) return line;
    }
    return undefined;
}

export interface DetailWindow {
    /** How many of the facts' lines fit (at most half the pane). */
    readonly facts: number;
    /** Lines left for the file, under its rule. */
    readonly fileRows: number;
    /** The first file line shown, clamped so the window stays full. */
    readonly top: number;
}

/**
 * The pane's `rows` from the top: a rule, the facts (capped at half, so the
 * plan always gets room), a rule naming the file, then the file from `top`.
 */
export function detailWindow(
    rows: number,
    factCount: number,
    fileCount: number,
    top: number,
): DetailWindow {
    const facts = Math.min(factCount, Math.max(1, Math.floor((rows - 2) / 2)));
    const fileRows = Math.max(0, rows - 2 - facts);
    const most = Math.max(0, fileCount - fileRows);
    return { facts, fileRows, top: Math.max(0, Math.min(top, most)) };
}
