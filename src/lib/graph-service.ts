import {
    type BrokenEdgeReport,
    type BuildGraphResult,
    buildGraph,
    type DuplicateIdReport,
    type GraphNode,
    type TaskRelationshipInput,
} from './graph';

/**
 * Stateful, file-scoped view of the relationship graph. Mirrors
 * `CacheService` in spirit: the activation layer calls `applyFileTasks`
 * after every parse, and `GraphService` keeps an incremental per-file +
 * per-id index so it never has to re-query the cache or re-parse files
 * to know "what's in the workspace right now."
 *
 * The derived snapshot (graph + duplicates) is rebuilt deterministically
 * from the index on every change via `buildGraph` from M9/A. The
 * canonical-winner / dangling / cycle / determinism rules of the pure
 * builder are inherited verbatim — this layer's only job is to maintain
 * the index incrementally so the input to `buildGraph` always reflects
 * the workspace's current state.
 *
 * Why not full incremental graph maintenance (reverse indices, per-node
 * mutation)? Workspaces are small (<1000 tasks); a fresh `buildGraph`
 * call from the in-memory index is microseconds. We get correctness for
 * free (the pure builder is the spec) and the invariant test in the
 * test suite drops to "snapshot equals buildGraph(allOccurrences)" by
 * construction. If profiling later shows the rebuild is hot, the
 * incremental path can swap in without breaking callers.
 */
export class GraphService {
    /** All occurrences of every id, grouped by id. */
    private occurrencesById = new Map<string, TaskRelationshipInput[]>();
    /** Which ids each file currently contributes. */
    private idsByFile = new Map<string, Set<string>>();
    /** Last derived snapshot — rebuilt on every applyFileTasks/removeFile. */
    private snapshot: BuildGraphResult = { graph: new Map(), duplicates: [] };

    /**
     * Replace a file's contribution to the graph. The previous occurrences
     * for `fileUri` are removed, then `tasks` are inserted, then the graph
     * snapshot is rebuilt from the merged occurrence index. Empty `tasks`
     * is equivalent to `removeFile(fileUri)`.
     */
    applyFileTasks(fileUri: string, tasks: readonly TaskRelationshipInput[]): void {
        this.removeFileFromIndex(fileUri);
        const newIds = new Set<string>();
        for (const task of tasks) {
            if (task.id === '') continue;
            newIds.add(task.id);
            const existing = this.occurrencesById.get(task.id);
            if (existing) {
                existing.push({ ...task, fileUri });
            } else {
                this.occurrencesById.set(task.id, [{ ...task, fileUri }]);
            }
        }
        if (newIds.size > 0) {
            this.idsByFile.set(fileUri, newIds);
        }
        this.rebuildSnapshot();
    }

    /** Drop every occurrence contributed by `fileUri`. */
    removeFile(fileUri: string): void {
        if (!this.idsByFile.has(fileUri)) return;
        this.removeFileFromIndex(fileUri);
        this.rebuildSnapshot();
    }

    /**
     * Reset state to empty. Counterpart to `CacheService.purge()` — used
     * by `tsk.rebuildCache` so a fresh scan starts from a clean graph.
     */
    purge(): void {
        this.occurrencesById.clear();
        this.idsByFile.clear();
        this.snapshot = { graph: new Map(), duplicates: [] };
    }

    /** Canonical node for `id`, or `undefined` if no occurrence exists. */
    getNode(id: string): GraphNode | undefined {
        return this.snapshot.graph.get(id);
    }

    /** Current snapshot of the full graph. */
    getGraph(): ReadonlyMap<string, GraphNode> {
        return this.snapshot.graph;
    }

    /** Every id that has more than one occurrence, sorted alphabetically. */
    getDuplicates(): readonly DuplicateIdReport[] {
        return this.snapshot.duplicates;
    }

    /**
     * Every forward edge whose target id has no canonical occurrence in
     * the workspace. Walks the canonical graph (so dup losers aren't
     * double-reported; their canonical winner is the only source that
     * surfaces a broken edge for the same id). Emits one report per
     * `(source, key)` pair — a task with all three of `@parent`,
     * `@dependsOn`, `@relatedTo` pointing at unknown ids produces three
     * reports.
     */
    getBrokenForwardEdges(): readonly BrokenEdgeReport[] {
        const reports: BrokenEdgeReport[] = [];
        for (const node of this.snapshot.graph.values()) {
            for (const key of ['parent', 'dependsOn', 'relatedTo', 'movedTo'] as const) {
                const targetId = node.forward[key];
                if (!targetId) continue;
                if (this.snapshot.graph.has(targetId)) continue;
                reports.push({
                    sourceId: node.id,
                    sourceFile: node.fileUri,
                    sourceLine: node.line,
                    key,
                    targetId,
                });
            }
        }
        return reports;
    }

    /** Counts — useful for activation logging + diagnostics drift checks. */
    counts(): { nodes: number; occurrences: number; duplicateIds: number } {
        let occurrences = 0;
        for (const list of this.occurrencesById.values()) occurrences += list.length;
        return {
            nodes: this.snapshot.graph.size,
            occurrences,
            duplicateIds: this.snapshot.duplicates.length,
        };
    }

    private removeFileFromIndex(fileUri: string): void {
        const oldIds = this.idsByFile.get(fileUri);
        if (!oldIds) return;
        for (const id of oldIds) {
            const list = this.occurrencesById.get(id);
            if (!list) continue;
            const filtered = list.filter((occ) => occ.fileUri !== fileUri);
            if (filtered.length === 0) {
                this.occurrencesById.delete(id);
            } else {
                this.occurrencesById.set(id, filtered);
            }
        }
        this.idsByFile.delete(fileUri);
    }

    private rebuildSnapshot(): void {
        const allOccurrences: TaskRelationshipInput[] = [];
        for (const list of this.occurrencesById.values()) {
            for (const occ of list) allOccurrences.push(occ);
        }
        this.snapshot = buildGraph(allOccurrences);
    }
}
