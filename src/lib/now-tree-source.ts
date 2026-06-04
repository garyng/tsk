import type { NodeId, TreeNode } from '@grida/tree-view';
import type { NowRowView } from './now-tree-view-model';

/**
 * Synthetic root id for the grida tree. Rendered hidden (`showRoot:false`);
 * never collides with an entryId (those are nanoids, never `<root>`).
 */
export const NOW_TREE_ROOT: NodeId = '<root>';

/**
 * Reconstruct a grida `TreeSource` payload from the linear-compaction rows.
 *
 * grida derives `Row.depth` from tree *nesting* and flattens the tree itself,
 * so to render our custom compacted depths we hand it a SYNTHETIC tree whose
 * nesting equals our `depth`: each row's parent is the nearest preceding row
 * at `depth − 1` (the hidden root for depth 0). grida's flatten of this tree
 * (all containers expanded) reproduces the input rows exactly; `isContainer`
 * then equals our `isFork` by construction, and a linear offshoot's nodes
 * become siblings — so collapsing a fork hides precisely its offshoot.
 */
export function buildNowTreeSource(rows: NowRowView[]): {
    root: NodeId;
    nodes: TreeNode<NowRowView>[];
} {
    const children = new Map<NodeId, NodeId[]>([[NOW_TREE_ROOT, []]]);
    const parentOf = new Map<NodeId, NodeId>();
    const lineage: NodeId[] = []; // lineage[d] = the current ancestor at depth d

    for (const row of rows) {
        // The depth-(d−1) ancestor is always set: rows arrive parent-before-child
        // with depth increasing by at most 1 (layoutNowTree's invariant).
        const parent = row.depth === 0 ? NOW_TREE_ROOT : (lineage[row.depth - 1] as NodeId);
        parentOf.set(row.entryId, parent);
        (children.get(parent) as NodeId[]).push(row.entryId);
        children.set(row.entryId, []);
        lineage[row.depth] = row.entryId;
        lineage.length = row.depth + 1; // forget now-stale deeper ancestors
    }

    const nodes: TreeNode<NowRowView>[] = [
        { id: NOW_TREE_ROOT, parent: null, children: children.get(NOW_TREE_ROOT) as NodeId[] },
        ...rows.map((row) => ({
            id: row.entryId,
            parent: parentOf.get(row.entryId) as NodeId,
            children: children.get(row.entryId) as NodeId[],
            meta: row,
        })),
    ];
    return { root: NOW_TREE_ROOT, nodes };
}

/**
 * The container (fork) entryIds — the set to mark expanded for the
 * fully-expanded compacted view (every offshoot visible).
 */
export function expandedNowIds(rows: NowRowView[]): NodeId[] {
    return rows.filter((r) => r.isFork).map((r) => r.entryId);
}
