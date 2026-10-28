/**
 * Linear compaction of a forest — the git-graph / undo-tree layout: a chain of
 * single children stays at one depth, and only a real fork (two or more
 * children) indents. So depth tracks *branching*, not chain length, and a long
 * run of sidetracks stays inside a narrow pane.
 *
 * Shared by the Now Stack (its off-trunk branches) and the `tsk` TUI. Generic
 * over the node type; the caller says how to find a node's children. Pure.
 */

export interface CompactRow<T> {
    readonly node: T;
    readonly depth: number;
    /** Two or more children: they indent under this row. */
    readonly isFork: boolean;
    /** The only child of the row above, so drawn at its depth (a renderer may mark the link). */
    readonly chained: boolean;
}

/** Append `start`'s subtree to `out`, compacted, starting at `depth`. */
export function compactSubtree<T>(
    start: T,
    depth: number,
    childrenOf: (node: T) => readonly T[],
    out: CompactRow<T>[],
): void {
    let node: T | undefined = start;
    let chained = false;
    while (node !== undefined) {
        const kids = childrenOf(node);
        out.push({ node, depth, isFork: kids.length >= 2, chained });
        if (kids.length === 1) {
            node = kids[0]; // linear → keep the same depth
            chained = true;
        } else {
            for (const kid of kids) compactSubtree(kid, depth + 1, childrenOf, out); // fork → indent
            node = undefined;
        }
    }
}

/** Every root's subtree, compacted, roots at `depth`. */
export function compactForest<T>(
    roots: readonly T[],
    childrenOf: (node: T) => readonly T[],
    depth = 0,
): CompactRow<T>[] {
    const out: CompactRow<T>[] = [];
    for (const root of roots) compactSubtree(root, depth, childrenOf, out);
    return out;
}
