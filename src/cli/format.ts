import path from 'node:path';
import { blockers, type Dep, dependencies, dependents } from '../lib/dependencies';
import { GLYPH } from '../lib/markers';
import { agentOf, isOpen, type Trail } from '../lib/session-focus';
import { outsideFileOf, pathTo, type TaskTree, type TreeNode } from '../lib/task-tree';

/**
 * Plain-text output of the `tsk` command line. It is read by Claude as much as
 * by a person, so every task is printed the same way — marker, id, text — and
 * nothing grows wider with depth: a trail is a numbered list, and a listing
 * stops indenting past {@link MAX_LIST_INDENT} levels and prints the depth.
 */

/** Deeper levels than this print `↳<depth>` instead of indenting further. */
const MAX_LIST_INDENT = 4;

export function label(node: TreeNode): string {
    return `[${GLYPH[node.task.marker]}] ${node.id ?? '(no id)'} ${node.task.content}`;
}

/** `  (waits on a, b)` after an open task something still blocks, else nothing. */
export function waitNote(tree: TaskTree, node: TreeNode): string {
    if (!isOpen(node.task.marker)) return '';
    const ids = [...new Set(blockers(tree, node).map((b) => b.id))];
    return ids.length > 0 ? `  (waits on ${ids.join(', ')})` : '';
}

/** A task, and the file it's in when that's one beside the tree's own. */
function labelIn(tree: TaskTree, node: TreeNode): string {
    const file = outsideFileOf(tree, node);
    return file ? `${label(node)}  (${path.basename(file)})` : label(node);
}

/** A dependency: the task, or its id and that no file has it. */
function depLabel(tree: TaskTree, dep: Dep): string {
    return dep.node ? labelIn(tree, dep.node) : `${dep.id} (not in any file)`;
}

export function formatTrail(trail: Trail, session: string, tree: TaskTree): string {
    const out: string[] = [];
    if (trail.focus) {
        out.push(`trail (session ${session}):`);
        trail.path.forEach((n, i) => {
            out.push(`  ${i + 1} ${label(n)}${n === trail.focus ? '  ← focus' : ''}`);
        });
        out.push(
            trail.openChildren.length > 0
                ? 'open under the focus:'
                : 'nothing open under the focus',
        );
        for (const n of trail.openChildren) out.push(`    ${label(n)}${waitNote(tree, n)}`);
    } else {
        out.push(`no focus (session ${session}) — \`tsk focus <id>\` or \`tsk push <text>\``);
    }
    if (trail.withAgents.length > 0) {
        out.push('with agents:');
        for (const n of trail.withAgents) {
            out.push(`    ${label(n)}  (${agentOf(n)})${waitNote(tree, n)}`);
        }
    }
    if (trail.otherOpen.length > 0) {
        out.push('other open tasks of this session:');
        for (const n of trail.otherOpen) {
            const where = n.parent ? `  (in ${n.parent.id ?? '?'})` : '';
            out.push(`    ${label(n)}${where}${waitNote(tree, n)}`);
        }
    }
    return out.join('\n');
}

/**
 * `show`: the path down to `node`, what it depends on and what depends on it,
 * what a task above it makes it wait on, then its children.
 */
export function formatShow(tree: TaskTree, node: TreeNode): string {
    const path = pathTo(node);
    const out = path.map((n, i) => `  ${i + 1} ${label(n)}`);
    const deps = dependencies(tree, node);
    if (deps.length > 0) {
        out.push('depends on:');
        for (const d of deps) out.push(`    ${depLabel(tree, d)}`);
    }
    const inherited = blockers(tree, node).filter((b) => b.via !== node);
    for (const b of inherited) {
        out.push(`waits on, through ${b.via.id ?? '?'}: ${depLabel(tree, b)}`);
    }
    const needed = dependents(tree, node);
    if (needed.length > 0) {
        out.push('needed by:');
        for (const d of needed) out.push(`    ${labelIn(tree, d)}`);
    }
    out.push(node.children.length > 0 ? 'children:' : 'no children');
    for (const c of node.children) out.push(`    ${label(c)}${waitNote(tree, c)}`);
    return out.join('\n');
}

/**
 * `ready`: the tasks that can start now under `scope` (or in the file), and
 * — since they'd otherwise vanish from the list — any open task held back by
 * a dependency no file has.
 */
export function formatReady(
    tree: TaskTree,
    ready: readonly TreeNode[],
    scope: TreeNode | undefined,
    inScope: readonly TreeNode[],
): string {
    const where = scope ? ` under ${label(scope)}` : '';
    const out = [ready.length > 0 ? `ready${where}:` : `nothing ready${where}`];
    for (const n of ready) {
        const parent = n.parent && n.parent !== scope ? `  (in ${n.parent.id ?? '?'})` : '';
        out.push(`    ${label(n)}${parent}`);
    }
    const stranded = inScope.filter(
        (n) => isOpen(n.task.marker) && blockers(tree, n).some((b) => !b.node),
    );
    if (stranded.length > 0) {
        out.push('waiting on a task that is not in any file:');
        for (const n of stranded) out.push(`    ${label(n)}${waitNote(tree, n)}`);
    }
    return out.join('\n');
}

/**
 * `ls`: the tree, depth first. With `keep`, only the matching tasks and their
 * ancestors (so each one is shown in context).
 */
export function formatList(tree: TaskTree, keep?: (n: TreeNode) => boolean): string {
    let shown: Set<TreeNode> | undefined;
    if (keep) {
        shown = new Set();
        for (const n of tree.nodes) if (keep(n)) for (const a of pathTo(n)) shown.add(a);
    }
    const out: string[] = [];
    const walk = (n: TreeNode, depth: number) => {
        if (shown && !shown.has(n)) return;
        const indent = '  '.repeat(Math.min(depth, MAX_LIST_INDENT));
        const badge = depth > MAX_LIST_INDENT ? `↳${depth} ` : '';
        out.push(`${indent}${badge}${label(n)}${waitNote(tree, n)}`);
        for (const c of n.children) walk(c, depth + 1);
    };
    for (const r of tree.roots) walk(r, 0);
    return out.length > 0 ? out.join('\n') : '(no tasks)';
}
