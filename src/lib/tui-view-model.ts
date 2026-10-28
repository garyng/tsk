import path from 'node:path';
import { compactForest } from './compact-forest';
import { blockers, blocks, dependencies, dependencyLayers, dependents } from './dependencies';
import type { Marker } from './markers';
import { agentOf, isOpen, sessionOf, sessionTrail } from './session-focus';
import { tagSpans } from './tag-span';
import { lookupId, outsideFileOf, pathTo, type TaskTree, type TreeNode } from './task-tree';
import { wikiLinkSpans } from './wiki-link';

/**
 * What the `tsk` TUI shows, as plain data: a list of lines the Ink renderer
 * draws top to bottom, with only the task lines selectable. Pure, so every
 * layout rule here is unit-tested without a terminal.
 *
 * Deep trees stay inside a narrow side pane three ways:
 * - **linear compaction** (`compact-forest.ts`): a chain of only children stays
 *   at one depth, and only a fork indents;
 * - **hoisting**: the session view roots itself at the focus, and the tree
 *   view can be zoomed into any task — the ancestors become a breadcrumb,
 *   shortened in the middle to fit ({@link fitCrumbs});
 * - **a depth badge**: past a third of the width, indentation stops growing
 *   and `↳<depth>` takes over ({@link indentFor}).
 *
 * Dependencies (`dependencies.ts`) show as counts on every task line, and as
 * two views of their own: one task's ({@link dependencyLines}) and the whole
 * file's, in steps ({@link layerLines}).
 */

export type TuiLine =
    | { readonly kind: 'heading'; readonly text: string }
    /** The ancestors above what's shown, rendered with {@link fitCrumbs}. */
    | { readonly kind: 'crumbs'; readonly path: readonly TreeNode[] }
    | {
          readonly kind: 'task';
          readonly node: TreeNode;
          readonly depth: number;
          /** The only child of the task above, drawn at its depth. */
          readonly chained: boolean;
          readonly focus: boolean;
          /** Dim context after the text, e.g. which task it sits in. */
          readonly note?: string;
          /** Its own dependencies that still hold it back (open, or in no file). */
          readonly waits: number;
          /** Open tasks it holds back: they name it in `@dependsOn`, and it's still open. */
          readonly needed: number;
          /** Folded in the tree view: the tasks out of view under it. */
          readonly folded?: number;
          /** Shown only because a task under it matches the tree view's filter. */
          readonly context?: boolean;
          /**
           * For tree lines: whether the task at each depth on its path, 1 to
           * its own, is the last of its siblings in view ({@link markLasts}).
           * Without it, plain indentation.
           */
          readonly lasts?: readonly boolean[];
      };

export type TaskLine = Extract<TuiLine, { kind: 'task' }>;

/**
 * Each task line's {@link TaskLine.lasts}, read off the lines themselves: a
 * task is the last at its depth when the next task at that depth or above
 * is above it, or a heading comes first. Its ancestor at a depth is the
 * nearest task above it at that depth.
 */
export function markLasts(lines: readonly TuiLine[]): TuiLine[] {
    const lastAt = (i: number, depth: number): boolean => {
        for (let j = i + 1; j < lines.length; j++) {
            const l = lines[j];
            if (l?.kind !== 'task' || l.depth < depth) return true;
            if (l.depth === depth) return false;
        }
        return true;
    };
    const ancestorAt = (i: number, depth: number): number | undefined => {
        for (let j = i - 1; j >= 0; j--) {
            const l = lines[j];
            if (l?.kind !== 'task') return undefined;
            if (l.depth === depth) return j;
        }
        return undefined;
    };
    return lines.map((l, i) => {
        if (l.kind !== 'task') return l;
        const lasts = Array.from({ length: l.depth }, (_, k) => {
            const at = k + 1 === l.depth ? i : ancestorAt(i, k + 1);
            return at === undefined ? true : lastAt(at, k + 1);
        });
        return { ...l, lasts };
    });
}

interface LineShape {
    readonly depth: number;
    readonly chained: boolean;
    readonly focus: boolean;
    readonly note?: string;
}

/** A task from a file beside the tree's own names that file after its other notes. */
function noteFor(tree: TaskTree, node: TreeNode, note: string | undefined): string | undefined {
    const file = outsideFileOf(tree, node);
    if (!file) return note;
    return note ? `${note} · ${path.basename(file)}` : path.basename(file);
}

function taskLine(tree: TaskTree, node: TreeNode, shape: LineShape): TaskLine {
    return {
        kind: 'task',
        node,
        ...shape,
        note: noteFor(tree, node, shape.note),
        waits: dependencies(tree, node).filter(blocks).length,
        needed: isOpen(node.task.marker)
            ? dependents(tree, node).filter((d) => isOpen(d.task.marker)).length
            : 0,
    };
}

const taskLines = (
    tree: TaskTree,
    roots: readonly TreeNode[],
    childrenOf: (n: TreeNode) => readonly TreeNode[],
    focus: TreeNode | undefined,
): TuiLine[] =>
    compactForest(roots, childrenOf).map((r) =>
        taskLine(tree, r.node, { depth: r.depth, chained: r.chained, focus: r.node === focus }),
    );

/** Where a task listed on its own sits: `in <parent's title>`. */
const inParent = (n: TreeNode) =>
    n.parent ? `in ${shortTitle(n.parent.task.content)}` : undefined;

/**
 * A task's title, for a breadcrumb or a note: its text without `#tags` and
 * `[[links]]`, up to the first ` — ` or `: ` — tasks here are written
 * "title — detail" — so "in Later" instead of the whole line again.
 */
export function shortTitle(content: string): string {
    const cut = [...tagSpans(content), ...wikiLinkSpans(content)].sort(
        (a, b) => b.startCol - a.startCol,
    );
    let text = content;
    for (const s of cut) text = text.slice(0, s.startCol) + text.slice(s.endCol);
    text = text.replace(/\s+/g, ' ').trim();
    const end = [text.indexOf(' — '), text.indexOf(': ')].filter((i) => i > 0);
    return end.length > 0 ? text.slice(0, Math.min(...end)) : text;
}

/**
 * The session view: the focus's ancestors as a breadcrumb, its subtree, the
 * tasks handed to agents, and the session's other open tasks. A task with an
 * agent is listed under `agents` only, so it's left out of the subtree.
 */
export function sessionLines(tree: TaskTree, session: string | undefined): TuiLine[] {
    if (!session) return [{ kind: 'heading', text: 'no session — pass --session or --follow-pid' }];
    const trail = sessionTrail(tree, session);
    const handed = new Set(trail.withAgents);
    const lines: TuiLine[] = [];
    if (trail.focus) {
        if (trail.path.length > 1) lines.push({ kind: 'crumbs', path: trail.path.slice(0, -1) });
        const childrenOf = (n: TreeNode) => n.children.filter((c) => !handed.has(c));
        lines.push(...taskLines(tree, [trail.focus], childrenOf, trail.focus));
    } else {
        lines.push({ kind: 'heading', text: 'no focus — `tsk focus <id>` or `tsk push <text>`' });
    }
    const inSubtree = new Set(lines.flatMap((l) => (l.kind === 'task' ? [l.node] : [])));
    const listApart = (
        heading: string,
        nodes: readonly TreeNode[],
        note: (n: TreeNode) => string | undefined,
    ) => {
        if (nodes.length === 0) return;
        lines.push({ kind: 'heading', text: heading });
        for (const n of nodes) {
            lines.push(
                taskLine(tree, n, { depth: 0, chained: false, focus: false, note: note(n) }),
            );
        }
    };
    listApart('agents', trail.withAgents, (n) =>
        [agentOf(n), inParent(n)].filter(Boolean).join(' · '),
    );
    listApart(
        'also open',
        trail.otherOpen.filter((n) => !inSubtree.has(n)),
        inParent,
    );
    return markLasts(lines);
}

export interface TreeOptions {
    /** Zoom into this task: it becomes the root, its ancestors a breadcrumb. */
    readonly hoist?: string;
    /**
     * Only the tasks in these states, and the ancestors that lead to them as
     * {@link TaskLine.context}; every state when undefined.
     */
    readonly states?: ReadonlySet<Marker>;
    /** Only this session's tasks, and their ancestors. */
    readonly session?: string;
    /** Highlighted as the focus. */
    readonly focus?: TreeNode;
    /** The `@id`s of the tasks whose subtrees are out of view. One zoomed into stays open. */
    readonly folded?: ReadonlySet<string>;
    /**
     * The filter: only the tasks it picks, and the ancestors that lead to them
     * as {@link TaskLine.context}. The folds are set aside meanwhile, so no
     * match is out of view.
     */
    readonly match?: (n: TreeNode) => boolean;
}

/** The tree view: the whole file (or a zoomed-in part), compacted and filtered. */
export function treeLines(tree: TaskTree, opts: TreeOptions = {}): TuiLine[] {
    let keep: Set<TreeNode> | undefined;
    const hits = new Set<TreeNode>();
    if (opts.states || opts.session || opts.match) {
        keep = new Set();
        for (const n of tree.nodes) {
            if (opts.states && !opts.states.has(n.task.marker)) continue;
            if (opts.session && sessionOf(n) !== opts.session) continue;
            if (opts.match && !opts.match(n)) continue;
            hits.add(n);
            for (const a of pathTo(n)) keep.add(a);
        }
    }
    const kept = (n: TreeNode) => keep === undefined || keep.has(n);
    const hoisted = opts.hoist ? tree.byId.get(opts.hoist) : undefined;
    const lines: TuiLine[] = [];
    if (hoisted) {
        const above = pathTo(hoisted).slice(0, -1);
        if (above.length > 0) lines.push({ kind: 'crumbs', path: above });
    }
    const roots = (hoisted ? [hoisted] : tree.roots).filter(kept);
    const shown = (n: TreeNode) => n.children.filter(kept);
    const folded = (n: TreeNode) =>
        !opts.match && n !== hoisted && n.id !== undefined && opts.folded?.has(n.id) === true;
    const under = (n: TreeNode): number => shown(n).reduce((sum, c) => sum + 1 + under(c), 0);
    const marked = (line: TuiLine): TuiLine => {
        if (line.kind !== 'task') return line;
        if (opts.match) return hits.has(line.node) ? line : { ...line, context: true };
        // A task kept only for what it leads to: dimmed, as the filter's context is.
        const shown = opts.states && !hits.has(line.node) ? { ...line, context: true } : line;
        if (!folded(line.node)) return shown;
        const hidden = under(line.node);
        return hidden > 0 ? { ...shown, folded: hidden } : shown;
    };
    lines.push(
        ...taskLines(tree, roots, (n) => (folded(n) ? [] : shown(n)), opts.focus).map(marked),
    );
    if (roots.length === 0) {
        lines.push({ kind: 'heading', text: opts.match ? 'no task matches' : '(no tasks)' });
    }
    return markLasts(lines);
}

/**
 * The tree view's options nearest `opts` that show `node`, for selecting it
 * when asked from outside: a zoom it isn't under is dropped and the folds
 * above it opened, then the filter and the states shown are set aside, in
 * that order, only while they still leave it out.
 */
export function revealOptions(tree: TaskTree, node: TreeNode, opts: TreeOptions): TreeOptions {
    const shows = (o: TreeOptions) =>
        treeLines(tree, o).some((l) => l.kind === 'task' && l.node === node);
    const path = pathTo(node);
    const above = new Set(path.slice(0, -1).flatMap((n) => (n.id ? [n.id] : [])));
    let next: TreeOptions = {
        ...opts,
        hoist: path.some((n) => n.id === opts.hoist) ? opts.hoist : undefined,
        folded: opts.folded && new Set([...opts.folded].filter((id) => !above.has(id))),
    };
    if (!shows(next)) next = { ...next, match: undefined };
    if (!shows(next)) next = { ...next, states: undefined };
    return next;
}

/**
 * One task's dependencies: what it needs above it — its own `@dependsOn`, and
 * what the tasks it sits under still wait on, each followed back through
 * theirs — then the task, then what needs it, followed forward. Every task
 * appears once, so a diamond or a loop can't repeat or run away. `focus` is
 * marked wherever it appears.
 */
export function dependencyLines(tree: TaskTree, id: string, focus?: TreeNode): TuiLine[] {
    const subject = lookupId(tree, id);
    if (!subject) return [{ kind: 'heading', text: `no task @id:${id}` }];
    const seen = new Set<TreeNode>([subject]);
    /** A forest over `next`, each node claimed by the first path that reaches it. */
    const grow = (starts: readonly TreeNode[], next: (n: TreeNode) => readonly TreeNode[]) => {
        const kids = new Map<TreeNode, TreeNode[]>();
        const claim = (ns: readonly TreeNode[]) => {
            const fresh = ns.filter((n) => !seen.has(n));
            for (const n of fresh) seen.add(n);
            return fresh;
        };
        const roots = claim(starts);
        const visit = (n: TreeNode) => {
            const own = claim(next(n));
            kids.set(n, own);
            for (const k of own) visit(k);
        };
        for (const r of roots) visit(r);
        return { roots, childrenOf: (n: TreeNode) => kids.get(n) ?? [] };
    };
    const resolved = (n: TreeNode) =>
        dependencies(tree, n).flatMap((d) => (d.node ? [d.node] : []));

    const lines: TuiLine[] = [];
    const above = pathTo(subject).slice(0, -1);
    if (above.length > 0) lines.push({ kind: 'crumbs', path: above });
    const own = dependencies(tree, subject);
    const inherited = blockers(tree, subject).filter((b) => b.via !== subject && b.node);
    const needs = grow(
        [
            ...own.flatMap((d) => (d.node ? [d.node] : [])),
            ...inherited.flatMap((b) => b.node ?? []),
        ],
        resolved,
    );
    const missing = own.filter((d) => !d.node).map((d) => d.id);
    if (needs.roots.length > 0 || missing.length > 0) {
        lines.push({ kind: 'heading', text: 'needs' });
        const via = new Map(inherited.map((b) => [b.node, b.via]));
        for (const { node, depth, chained } of compactForest(needs.roots, needs.childrenOf)) {
            const through = depth === 0 && !chained ? via.get(node) : undefined;
            const note = through ? `through ${shortTitle(through.task.content)}` : undefined;
            lines.push(taskLine(tree, node, { depth, chained, focus: node === focus, note }));
        }
        for (const id of missing) lines.push({ kind: 'heading', text: `not in any file: ${id}` });
    } else {
        lines.push({ kind: 'heading', text: 'needs nothing' });
    }
    lines.push(taskLine(tree, subject, { depth: 0, chained: false, focus: subject === focus }));
    const neededBy = grow(dependents(tree, subject), (n) => dependents(tree, n));
    lines.push({
        kind: 'heading',
        text: neededBy.roots.length > 0 ? 'needed by' : 'nothing needs it',
    });
    for (const { node, depth, chained } of compactForest(neededBy.roots, neededBy.childrenOf)) {
        lines.push(taskLine(tree, node, { depth, chained, focus: node === focus }));
    }
    return markLasts(lines);
}

/**
 * The layered view of the whole file's dependencies, on its side for a
 * narrow pane: the open tasks that take part in one, in steps — step 1 can
 * start now, each later step waits only on earlier ones — then any loop.
 */
export function layerLines(tree: TaskTree, focus?: TreeNode): TuiLine[] {
    const { steps, cyclic } = dependencyLayers(tree);
    if (steps.length === 0 && cyclic.length === 0) {
        return [{ kind: 'heading', text: 'no dependencies — `tsk dep <id> --on <id>`' }];
    }
    const lines: TuiLine[] = [];
    const list = (nodes: readonly TreeNode[]) => {
        for (const n of nodes) {
            const shape = { depth: 0, chained: false, focus: n === focus, note: inParent(n) };
            lines.push(taskLine(tree, n, shape));
        }
    };
    steps.forEach((nodes, i) => {
        lines.push({ kind: 'heading', text: i === 0 ? 'step 1 · can start now' : `step ${i + 1}` });
        list(nodes);
    });
    if (cyclic.length > 0) {
        lines.push({ kind: 'heading', text: 'in a loop — or waiting on one' });
        list(cyclic);
    }
    return markLasts(lines);
}

/**
 * The ancestors' labels joined with ` › `, made to fit `width`: drop labels
 * from the middle (keeping the first and as many of the last as fit), then
 * truncate.
 */
export function fitCrumbs(labels: readonly string[], width: number, sep = ' › '): string {
    return crumbParts(labels, width, sep)
        .map((p) => p.text)
        .join('');
}

/** A piece of a fitted breadcrumb: a label (with its index among the labels), a separator, or `…`. */
export interface CrumbPart {
    readonly text: string;
    readonly index?: number;
}

/** {@link fitCrumbs} in pieces, so a click can tell which label it landed on. */
export function crumbParts(labels: readonly string[], width: number, sep = ' › '): CrumbPart[] {
    const join = (picks: readonly (number | '…')[]): CrumbPart[] =>
        picks.flatMap((pick, n) => [
            ...(n > 0 ? [{ text: sep }] : []),
            pick === '…' ? { text: '…' } : { text: labels[pick] ?? '', index: pick },
        ]);
    const fits = (parts: readonly CrumbPart[]) =>
        parts.reduce((w, p) => w + p.text.length, 0) <= width;
    const all = labels.map((_, i) => i);
    const full = join(all);
    if (fits(full) || labels.length === 0) return truncateParts(full, width);
    for (let k = labels.length - 2; k >= 1; k--) {
        const candidate = join([0, '…', ...all.slice(-k)]);
        if (fits(candidate)) return candidate;
    }
    return truncateParts(join(['…', labels.length - 1]), width);
}

/** The parts cut where {@link truncate} would cut their text, its `…` on the last part kept. */
function truncateParts(parts: readonly CrumbPart[], width: number): CrumbPart[] {
    const text = parts.map((p) => p.text).join('');
    const cut = truncate(text, width);
    if (cut === text) return [...parts];
    const ellipsis = !text.startsWith(cut);
    const keep = ellipsis ? cut.length - 1 : cut.length;
    const out: CrumbPart[] = [];
    let at = 0;
    for (const p of parts) {
        if (at >= keep) break;
        const t = p.text.slice(0, keep - at);
        out.push({ ...p, text: t });
        at += t.length;
    }
    const last = out.at(-1);
    if (ellipsis && last) out[out.length - 1] = { ...last, text: `${last.text}…` };
    return out;
}

export function truncate(text: string, width: number): string {
    if (text.length <= width) return text;
    return width <= 1 ? text.slice(0, Math.max(0, width)) : `${text.slice(0, width - 1)}…`;
}

/** Indent columns for `depth`, capped at a third of `width`; past the cap, a `↳<depth>` badge. */
export function indentFor(depth: number, width: number): { columns: number; badge?: string } {
    const maxLevels = Math.max(1, Math.floor(width / 3 / 2));
    if (depth <= maxLevels) return { columns: depth * 2 };
    return { columns: maxLevels * 2, badge: `↳${depth}` };
}
