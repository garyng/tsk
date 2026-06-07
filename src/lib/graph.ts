/**
 * Pure relationship-graph builder. Takes a flat list of task → forward-edge
 * tuples (id + the forward keys `parent` / `dependsOn` / `relatedTo` /
 * `movedTo`), groups them into a map of `GraphNode`s, computes inverse edges
 * (`children` / `dependents` / `related` / `movedHereFrom`), and reports
 * duplicate `@id`s.
 *
 * No I/O. No `vscode`. The M9/B wiring layer is responsible for extracting
 * `TaskRelationshipInput`s from the cache (joining the `tasks` + `metadata`
 * tables) and for routing the duplicates report through the warnings
 * convention. This layer just does the data transform.
 *
 * Design notes the consumer should know:
 *
 * - **Canonical-winner rule.** When the same `@id` appears in multiple
 *   tasks, the graph keeps the lexicographically lowest `(fileUri, line)`
 *   occurrence as the canonical node. Same rule applies later in the
 *   scoped-invalidation `GraphService` so a re-scan of file Y doesn't
 *   shake the graph node for an id whose canonical occurrence lives in
 *   file X.
 * - **Dangling forward edges are kept.** If `parent` points at an id
 *   that doesn't exist anywhere, the source node's `forward.parent`
 *   still carries that id — the consumer (M9/C codelens) can render a
 *   "(missing)" hint instead of silently dropping the edge.
 * - **Cycles are allowed.** Builder records what the metadata says; if
 *   tasks form a cycle (A.parent = B, B.parent = A), both forward and
 *   inverse edges populate normally.
 * - **Determinism.** Map iteration order is canonical-`(fileUri, line)`
 *   order. Inverse-edge arrays are sorted ascending by source id.
 *   Duplicates array is sorted ascending by `id`; each entry's
 *   `occurrences` array is sorted by `(fileUri, line)`.
 */

/**
 * The minimal per-task projection the builder needs. The wiring layer
 * joins the cache's `tasks` + `metadata` tables into this shape; the pure
 * builder doesn't know about the metadata table or the cache.
 */
export interface TaskRelationshipInput {
    readonly id: string;
    readonly fileUri: string;
    readonly line: number;
    readonly parent?: string;
    readonly dependsOn?: string;
    readonly relatedTo?: string;
    readonly movedTo?: string;
}

export interface GraphNode {
    readonly id: string;
    /** Where the canonical occurrence lives — file + line. */
    readonly fileUri: string;
    readonly line: number;
    /**
     * Forward edges. Targets are referenced by `@id`; resolve to a
     * `GraphNode` by looking them up in the parent map. A target id that
     * isn't in the map is a dangling edge (kept verbatim).
     */
    readonly forward: {
        readonly parent?: string;
        readonly dependsOn?: string;
        readonly relatedTo?: string;
        readonly movedTo?: string;
    };
    /** Inverse edges — ids of nodes whose forward edge points here. */
    readonly inverse: {
        readonly children: readonly string[];
        readonly dependents: readonly string[];
        readonly related: readonly string[];
        /** Ids of nodes whose `@movedTo` points here ("moved here from"). */
        readonly movedHereFrom: readonly string[];
    };
}

export interface DuplicateIdReport {
    readonly id: string;
    /** Every occurrence of this id across the workspace, ascending `(fileUri, line)`. */
    readonly occurrences: ReadonlyArray<{ readonly fileUri: string; readonly line: number }>;
}

/**
 * One forward edge whose target id has no canonical occurrence in the
 * graph. The source task (`sourceId` at `sourceFile:sourceLine`) carries
 * a `@<key>:<targetId>` metadata entry that points at a phantom node.
 *
 * Emitted by `GraphService.getBrokenForwardEdges()` and consumed by the
 * diagnostics manager to squiggle the source line with a Warning.
 */
export interface BrokenEdgeReport {
    readonly sourceId: string;
    readonly sourceFile: string;
    readonly sourceLine: number;
    readonly key: 'parent' | 'dependsOn' | 'relatedTo' | 'movedTo';
    readonly targetId: string;
}

export interface BuildGraphResult {
    readonly graph: ReadonlyMap<string, GraphNode>;
    readonly duplicates: readonly DuplicateIdReport[];
}

interface MutableInverse {
    children: string[];
    dependents: string[];
    related: string[];
    movedHereFrom: string[];
}

/**
 * Build the graph + duplicate report from a flat task list. See file
 * header for canonical-winner / dangling / cycle / determinism rules.
 */
export function buildGraph(tasks: readonly TaskRelationshipInput[]): BuildGraphResult {
    // Pass 1: group occurrences by id. Skip empty ids — those represent
    // un-id'd tasks (warned at cache scan time, not the graph's concern).
    const occurrencesById = new Map<string, TaskRelationshipInput[]>();
    for (const task of tasks) {
        if (task.id === '') continue;
        const list = occurrencesById.get(task.id);
        if (list) {
            list.push(task);
        } else {
            occurrencesById.set(task.id, [task]);
        }
    }

    // Pass 2: pick canonical winner per id. Within each occurrence list,
    // the lexicographically lowest `(fileUri, line)` wins. The remaining
    // occurrences feed the duplicates report.
    interface CanonicalEntry {
        canonical: TaskRelationshipInput;
        all: TaskRelationshipInput[];
    }
    const canonicalById = new Map<string, CanonicalEntry>();
    for (const [id, list] of occurrencesById) {
        list.sort(compareOccurrence);
        const canonical = list[0];
        if (canonical === undefined) continue;
        canonicalById.set(id, { canonical, all: list });
    }

    // Pass 3: walk canonical entries in canonical-(fileUri, line) order to
    // determine Map insertion order. We're aiming for deterministic
    // iteration so e2e snapshots and code-lens ordering stay stable.
    const orderedEntries = [...canonicalById.entries()].sort((a, b) =>
        compareOccurrence(a[1].canonical, b[1].canonical),
    );

    // Pass 4: seed nodes with forward edges and empty inverse buckets.
    interface MutableForward {
        parent?: string;
        dependsOn?: string;
        relatedTo?: string;
        movedTo?: string;
    }
    const inverseBuckets = new Map<string, MutableInverse>();
    const nodeStubs = new Map<
        string,
        {
            canonical: TaskRelationshipInput;
            forward: MutableForward;
            inverse: MutableInverse;
        }
    >();
    for (const [id, entry] of orderedEntries) {
        const forward: MutableForward = {};
        if (entry.canonical.parent !== undefined) forward.parent = entry.canonical.parent;
        if (entry.canonical.dependsOn !== undefined) forward.dependsOn = entry.canonical.dependsOn;
        if (entry.canonical.relatedTo !== undefined) forward.relatedTo = entry.canonical.relatedTo;
        if (entry.canonical.movedTo !== undefined) forward.movedTo = entry.canonical.movedTo;
        const inverse: MutableInverse = {
            children: [],
            dependents: [],
            related: [],
            movedHereFrom: [],
        };
        inverseBuckets.set(id, inverse);
        nodeStubs.set(id, { canonical: entry.canonical, forward, inverse });
    }

    // Pass 5: populate inverse edges. Walk canonical winners only — a
    // duplicate task's forward edges are *not* honored (only the winner
    // contributes to the graph topology).
    for (const [sourceId, stub] of nodeStubs) {
        const { forward } = stub;
        if (forward.parent !== undefined) {
            const targetBucket = inverseBuckets.get(forward.parent);
            if (targetBucket) targetBucket.children.push(sourceId);
        }
        if (forward.dependsOn !== undefined) {
            const targetBucket = inverseBuckets.get(forward.dependsOn);
            if (targetBucket) targetBucket.dependents.push(sourceId);
        }
        if (forward.relatedTo !== undefined) {
            const targetBucket = inverseBuckets.get(forward.relatedTo);
            if (targetBucket) targetBucket.related.push(sourceId);
        }
        if (forward.movedTo !== undefined) {
            const targetBucket = inverseBuckets.get(forward.movedTo);
            if (targetBucket) targetBucket.movedHereFrom.push(sourceId);
        }
    }

    // Pass 6: sort inverse-edge arrays and freeze final nodes.
    const graph = new Map<string, GraphNode>();
    for (const [id, stub] of nodeStubs) {
        stub.inverse.children.sort();
        stub.inverse.dependents.sort();
        stub.inverse.related.sort();
        stub.inverse.movedHereFrom.sort();
        graph.set(id, {
            id,
            fileUri: stub.canonical.fileUri,
            line: stub.canonical.line,
            forward: stub.forward,
            inverse: stub.inverse,
        });
    }

    // Pass 7: build duplicates report — every id whose occurrence list
    // has more than one entry. Ascending by id for deterministic output.
    const duplicates: DuplicateIdReport[] = [];
    for (const [id, entry] of orderedEntries) {
        if (entry.all.length < 2) continue;
        duplicates.push({
            id,
            occurrences: entry.all.map((occ) => ({ fileUri: occ.fileUri, line: occ.line })),
        });
    }
    duplicates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    return { graph, duplicates };
}

function compareOccurrence(a: TaskRelationshipInput, b: TaskRelationshipInput): number {
    if (a.fileUri !== b.fileUri) return a.fileUri < b.fileUri ? -1 : 1;
    return a.line - b.line;
}
