import { matchDivider } from './divider';
import { indentColumn } from './move-task-logic';
import { parseLine, type Task } from './parser';

/**
 * The parent/child tree of one `.tsk` document, as a person reads it:
 * **indentation is the tree, and an explicit `@parent` beats indentation.**
 *
 * The `@parent` override exists because the `tsk` command line caps how deep
 * it nests (see {@link MAX_NEST_LEVELS}): a sidetrack past the cap is written
 * flat, at the cap's depth, carrying `@parent:<id>`. It also keeps a block
 * attached to its parent after someone moves it by hand.
 *
 * Rules, in order:
 *
 * - A task's indentation parent is the nearest preceding task at a smaller
 *   indent column. Any non-blank line closes the tasks at its column or deeper
 *   (so prose at column 0 ends a block), but only tasks become parents.
 * - A divider line (`-label---`) closes every open task: sections never nest.
 * - `@parent:<id>` naming a task in this document wins, unless it would make a
 *   cycle — then the indentation parent stands. A `@parent` naming a task that
 *   isn't here (another file, or a typo) also falls back to indentation, so
 *   the node stays where the reader sees it.
 * - Duplicate `@id`s: the first occurrence owns the id (the extension's
 *   canonical-winner rule, within one file).
 *
 * Pure — no I/O.
 */

/** Columns a tab advances to when measuring indentation. */
const TAB_SIZE = 2;
/** Columns per nesting level, as the command line writes them. */
const LEVEL_COLUMNS = 2;

/**
 * How many levels deep the command line nests by indentation: plan › phase ›
 * task › one sidetrack. Deeper sidetracks are written flat at the last level
 * with `@parent` (the deepest line is then indented 6 spaces), so a runaway
 * chain can't push the file off-screen.
 */
export const MAX_NEST_LEVELS = 4;

export interface TreeNode {
    readonly task: Task;
    /** The task's `@id`, when it has one. */
    readonly id: string | undefined;
    /** Visual indent column of the task line. */
    readonly column: number;
    /** Resolved parent: `@parent` when it names a task here, else indentation. */
    parent: TreeNode | undefined;
    /** Resolved children, in document order. */
    readonly children: TreeNode[];
}

export interface TaskTree {
    readonly lines: readonly string[];
    /** Every task, in document order. */
    readonly nodes: readonly TreeNode[];
    readonly roots: readonly TreeNode[];
    readonly byId: ReadonlyMap<string, TreeNode>;
    /** Task nodes by their zero-based line number. */
    readonly byLine: ReadonlyMap<number, TreeNode>;
    /** The other `.tsk` files beside this one, read only ({@link withOutside}). */
    readonly outside?: Outside;
}

/** Another `.tsk` file's tasks, for the ids this one names but doesn't have. */
export interface OutsideFile {
    readonly file: string;
    readonly tree: TaskTree;
}

export interface Outside {
    readonly files: readonly OutsideFile[];
    /** Their tasks by `@id`: an id this file has isn't here, and between them the first file wins. */
    readonly byId: ReadonlyMap<string, TreeNode>;
    /** Which file each of their tasks is in. */
    readonly fileOf: ReadonlyMap<TreeNode, string>;
}

/** `tree`, looking in `files` for an `@id` it doesn't have (`dependencies.ts`). */
export function withOutside(tree: TaskTree, files: readonly OutsideFile[]): TaskTree {
    const byId = new Map<string, TreeNode>();
    const fileOf = new Map<TreeNode, string>();
    for (const f of files) {
        for (const n of f.tree.nodes) {
            fileOf.set(n, f.file);
            if (n.id !== undefined && !tree.byId.has(n.id) && !byId.has(n.id)) byId.set(n.id, n);
        }
    }
    return { ...tree, outside: { files, byId, fileOf } };
}

/** The task with `@id` `id`: in the tree's own file, else in one beside it. */
export function lookupId(tree: TaskTree, id: string): TreeNode | undefined {
    return tree.byId.get(id) ?? tree.outside?.byId.get(id);
}

/** The file `node` is in, when it isn't the tree's own. */
export function outsideFileOf(tree: TaskTree, node: TreeNode): string | undefined {
    return tree.outside?.fileOf.get(node);
}

export function buildTaskTree(lines: readonly string[]): TaskTree {
    const nodes: TreeNode[] = [];
    const byId = new Map<string, TreeNode>();
    const byLine = new Map<number, TreeNode>();
    let open: TreeNode[] = [];

    for (let i = 0; i < lines.length; i++) {
        const text = lines[i] as string;
        if (text.trim() === '') continue;
        if (matchDivider(text)) {
            open = [];
            continue;
        }
        const column = indentColumn(text, TAB_SIZE);
        while (open.length > 0 && (open[open.length - 1] as TreeNode).column >= column) open.pop();
        const parsed = parseLine(text);
        if (!parsed) continue;
        const id = parsed.metadata.get('id') ?? undefined;
        const node: TreeNode = {
            task: { ...parsed, line: i },
            id: id || undefined,
            column,
            parent: open[open.length - 1],
            children: [],
        };
        nodes.push(node);
        byLine.set(i, node);
        if (node.id !== undefined && !byId.has(node.id)) byId.set(node.id, node);
        open.push(node);
    }

    // Indentation alone is a forest; each override is checked against the
    // current parents before it's applied, so the tree never gains a cycle.
    for (const node of nodes) {
        const ref = node.task.metadata.get('parent');
        if (!ref) continue;
        const target = byId.get(ref);
        if (target === undefined || target === node || isAncestorOrSelf(node, target)) continue;
        node.parent = target;
    }

    const roots: TreeNode[] = [];
    for (const node of nodes) {
        if (node.parent) node.parent.children.push(node);
        else roots.push(node);
    }
    return { lines, nodes, roots, byId, byLine };
}

/** True when `ancestor` is `node` or appears on `node`'s parent chain. Cycle-safe. */
export function isAncestorOrSelf(ancestor: TreeNode, node: TreeNode | undefined): boolean {
    const seen = new Set<TreeNode>();
    for (let cur = node; cur !== undefined && !seen.has(cur); cur = cur.parent) {
        if (cur === ancestor) return true;
        seen.add(cur);
    }
    return false;
}

/** The chain from the root down to `node`, inclusive. */
export function pathTo(node: TreeNode): TreeNode[] {
    const path: TreeNode[] = [];
    const seen = new Set<TreeNode>();
    for (let cur: TreeNode | undefined = node; cur && !seen.has(cur); cur = cur.parent) {
        path.unshift(cur);
        seen.add(cur);
    }
    return path;
}

/** `root` and everything nested under it, depth first (file order). */
export function subtreeNodes(root: TreeNode): TreeNode[] {
    const out: TreeNode[] = [];
    const walk = (n: TreeNode) => {
        out.push(n);
        for (const c of n.children) walk(c);
    };
    walk(root);
    return out;
}

/** Nesting level of a task line by its indentation (0 = column 0). */
export function indentLevel(node: TreeNode): number {
    return Math.floor(node.column / LEVEL_COLUMNS);
}

/**
 * The last line of the contiguous run that belongs to `node`: its indented
 * block, plus any directly following tasks that are its descendants through
 * `@parent` (the flat-at-the-cap sidetracks) and their own blocks. Trailing
 * blank lines are excluded. Where a new last child of `node` goes.
 */
export function subtreeEnd(tree: TaskTree, node: TreeNode): number {
    let end = node.task.line;
    for (let i = end + 1; i < tree.lines.length; i++) {
        const text = tree.lines[i] as string;
        if (text.trim() === '') continue;
        if (matchDivider(text)) break;
        const task = tree.byLine.get(i);
        const deeper = indentColumn(text, TAB_SIZE) > node.column;
        if (deeper || (task !== undefined && isAncestorOrSelf(node, task))) end = i;
        else break;
    }
    return end;
}
