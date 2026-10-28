import { LIST_KEY, parseIdList } from './relationships';
import { isOpen } from './session-focus';
import {
    isAncestorOrSelf,
    lookupId,
    pathTo,
    subtreeNodes,
    type TaskTree,
    type TreeNode,
} from './task-tree';

/**
 * The `@dependsOn` graph of one file, read off its {@link TaskTree}: what a
 * task waits on, what waits on it, what can start now, and the order the rest
 * can follow. Pure; the CLI (`tsk dep` / `ready` / `show` / `trail`) and the
 * TUI (badges, the dependency and layered views) share it.
 *
 * **Blocking is inherited through nesting.** A task waits on its own open
 * dependencies and on those of every task it sits under — the sub-steps of a
 * phase that waits wait too, since nesting reads as "part of". A dependency
 * that isn't in the file, or in one beside it, blocks as well: it can't be
 * checked. Finished, cancelled, moved and note targets don't.
 *
 * **Other files are read only.** An id the file doesn't have is looked for in
 * the `.tsk` files beside it ({@link TaskTree.outside}), so a task can wait on
 * one in another file; those tasks are followed for loops, steps and
 * dependents like the file's own.
 *
 * (The extension's `graph.ts` is the workspace-wide graph behind code lenses,
 * built from the cache across files; this one is a single file's, built from
 * its text, for tools that run without VS Code.)
 */

/** One `@dependsOn` entry, resolved: the task, or just the id when no file has it. */
export interface Dep {
    readonly id: string;
    readonly node: TreeNode | undefined;
}

/** A dependency that keeps a task from starting, and the task (itself or one it sits under) that names it. */
export interface Blocker extends Dep {
    readonly via: TreeNode;
}

/** The ids `node` names in `@dependsOn`, in written order. */
export function dependsOnIds(node: TreeNode): string[] {
    return parseIdList(node.task.metadata.get(LIST_KEY));
}

export function dependencies(tree: TaskTree, node: TreeNode): Dep[] {
    return dependsOnIds(node).map((id) => ({ id, node: lookupId(tree, id) }));
}

/** Whether a dependency still holds a task back: open, or in no file. */
export function blocks(dep: Dep): boolean {
    return dep.node === undefined || isOpen(dep.node.task.marker);
}

/** The tasks that name `node` in `@dependsOn`, in file order. */
export function dependents(tree: TaskTree, node: TreeNode): readonly TreeNode[] {
    if (!node.id) return [];
    return dependentsIndex(tree).get(node.id) ?? [];
}

/** What keeps `node` from starting: the blocking dependencies of it and of every task above it. */
export function blockers(tree: TaskTree, node: TreeNode): Blocker[] {
    const out: Blocker[] = [];
    for (const via of pathTo(node)) {
        for (const dep of dependencies(tree, via)) if (blocks(dep)) out.push({ ...dep, via });
    }
    return out;
}

/** A `[ ]` task that nothing blocks. */
export function isReady(tree: TaskTree, node: TreeNode): boolean {
    return node.task.marker === 'todo' && blockers(tree, node).length === 0;
}

/** The ready tasks in file order — under `within` (itself included), or in the whole file. */
export function readyTasks(tree: TaskTree, within?: TreeNode): TreeNode[] {
    const scope = within ? subtreeNodes(within) : tree.nodes;
    return scope.filter((n) => isReady(tree, n));
}

/**
 * The loop that `from` depending on `on` would close, or `undefined` if it
 * closes none: the chain of tasks from `on` that each wait on the next, ending
 * at `from` or a task inside it (which waits on everything `from` waits on).
 * Every edge counts, whatever the status, so the graph stays a DAG.
 */
export function cycleIfDepends(
    tree: TaskTree,
    from: TreeNode,
    on: TreeNode,
): TreeNode[] | undefined {
    const cameFrom = new Map<TreeNode, TreeNode | undefined>([[on, undefined]]);
    const queue = [on];
    for (let n = queue.shift(); n; n = queue.shift()) {
        if (isAncestorOrSelf(from, n)) {
            const chain: TreeNode[] = [];
            for (let c: TreeNode | undefined = n; c; c = cameFrom.get(c)) chain.unshift(c);
            return chain;
        }
        for (const next of waitsOn(tree, n)) {
            if (cameFrom.has(next)) continue;
            cameFrom.set(next, n);
            queue.push(next);
        }
    }
    return undefined;
}

/**
 * The open tasks that take part in a dependency — they name one, or an open
 * task names them — in steps: step 0 can start now, and each later step waits
 * only on earlier ones. Tasks on a loop, or waiting on one, can't be placed
 * and are returned apart. Each step is in file order.
 */
export function dependencyLayers(tree: TaskTree): {
    steps: TreeNode[][];
    cyclic: TreeNode[];
} {
    const open = tree.nodes.filter((n) => isOpen(n.task.marker));
    const shown = new Set<TreeNode>();
    for (const n of open) {
        const deps = dependencies(tree, n);
        if (deps.length > 0) shown.add(n);
        for (const d of deps) if (d.node && isOpen(d.node.task.marker)) shown.add(d.node);
    }
    const step = new Map<TreeNode, number>();
    const cyclic = new Set<TreeNode>();
    const visiting = new Set<TreeNode>();
    const place = (n: TreeNode): number | undefined => {
        if (cyclic.has(n)) return undefined;
        const known = step.get(n);
        if (known !== undefined) return known;
        if (visiting.has(n)) return undefined;
        visiting.add(n);
        let at = 0;
        let placeable = true;
        for (const b of blockers(tree, n)) {
            if (!b.node) {
                at = Math.max(at, 1);
                continue;
            }
            const s = place(b.node);
            if (s === undefined) placeable = false;
            else at = Math.max(at, s + 1);
        }
        visiting.delete(n);
        if (!placeable) {
            cyclic.add(n);
            return undefined;
        }
        step.set(n, at);
        return at;
    };
    // The file's own, then the ones from other files it waits on.
    const order = [...tree.nodes, ...[...shown].filter((n) => outsideOf(tree, n))];
    const steps: TreeNode[][] = [];
    for (const n of order) {
        if (!shown.has(n)) continue;
        const s = place(n);
        if (s === undefined) continue;
        while (steps.length <= s) steps.push([]);
        steps[s]?.push(n);
    }
    return {
        steps: steps.filter((s) => s.length > 0),
        cyclic: order.filter((n) => shown.has(n) && cyclic.has(n)),
    };
}

/** The tasks `node` waits on, by any edge: its own `@dependsOn` and those of every task above it. */
function waitsOn(tree: TaskTree, node: TreeNode): TreeNode[] {
    const out: TreeNode[] = [];
    for (const via of pathTo(node)) {
        for (const dep of dependencies(tree, via)) if (dep.node) out.push(dep.node);
    }
    return out;
}

const outsideOf = (tree: TaskTree, n: TreeNode) => tree.outside?.fileOf.has(n) === true;

const DEPENDENTS = new WeakMap<TaskTree, Map<string, TreeNode[]>>();

/** id → the tasks naming it, built once per tree (a tree is never mutated). */
function dependentsIndex(tree: TaskTree): Map<string, TreeNode[]> {
    let index = DEPENDENTS.get(tree);
    if (!index) {
        index = new Map();
        for (const n of [...tree.nodes, ...(tree.outside?.fileOf.keys() ?? [])]) {
            for (const id of dependsOnIds(n)) {
                const list = index.get(id);
                if (list) list.push(n);
                else index.set(id, [n]);
            }
        }
        DEPENDENTS.set(tree, index);
    }
    return index;
}
