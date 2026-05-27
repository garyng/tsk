import type { GraphNode } from './graph';

/**
 * Vscode-free descriptor for a single code lens. The activation layer
 * converts each one into a `vscode.CodeLens` with the matching command +
 * arguments; tests can assert against this shape without instantiating a
 * VSCode host.
 *
 * Argument semantics by command:
 *
 *   - **Navigate** (`tsk.goToParent` / `goToDependsOn` / `goToRelated`):
 *     args = `[targetId]`. The handler resolves the target via the graph
 *     at invocation time (the graph may have shifted between lens render
 *     and click; deferring the lookup is the only correct option).
 *   - **Peek** (`tsk.findAllChildren` / `findAllDependents` /
 *     `findAllRelated`): args = `[sourceUri, sourceLine, targetIds]`.
 *     The handler resolves each `targetId` to a Location at invocation
 *     time, then anchors the peek view at `(sourceUri, sourceLine)`.
 *   - **Missing** (`tsk.codelens.missing`): args = `[targetId, label]`
 *     where `label` is the relationship name ("parent" / "dependsOn" /
 *     "relatedTo") so the toast can name the relationship for context.
 */
export interface LensDescriptor {
    line: number;
    title: string;
    command: string;
    args: unknown[];
}

/** A canonical-node lookup, parameterised so tests can use stubs. */
export type GraphLookup = (id: string) => GraphNode | undefined;

/**
 * Single source of truth for the codicon glyph prepended to each lens
 * title. VSCode renders these inline via the `$(codicon-name)` syntax.
 * Exported so tests, the demo, and the README can all reference this
 * map by name rather than duplicating literal glyph strings — if these
 * ever become a user-facing setting, only this object changes.
 *
 * Convention (informs the current defaults, will inform any future
 * configuration UX too):
 *
 *   - **Triangles** mark the *structural* pairs (parent/children for
 *     the vertical hierarchy, dependsOn/dependents for the temporal
 *     flow). They read as "follow the slot in the structure."
 *   - **Thinner arrows** mark the *lateral* relatedTo/related link —
 *     a free-form pointer, not a hierarchy slot.
 *   - **`warning`** marks dangling forward edges, since the click opens
 *     an info toast rather than navigating.
 */
export const CODICONS = {
    parent: 'triangle-up',
    children: 'triangle-down',
    dependsOn: 'triangle-left',
    dependents: 'triangle-right',
    relatedTo: 'arrow-right',
    related: 'arrow-left',
    missing: 'warning',
} as const;

type ForwardLabel = 'parent' | 'dependsOn' | 'relatedTo';
type InverseLabel = 'children' | 'dependents' | 'related';

/** The minimum projection of a parsed task the lens computer needs. */
export interface TaskForLenses {
    line: number;
    metadata: ReadonlyMap<string, string | null>;
}

/**
 * Produce the lens set for one task. Returns an empty array when:
 *
 *   - the task has no `@id` (it can't be a graph node and inverse edges
 *     don't apply; the existing `no-id` warning is the user's hint), OR
 *   - the task's id has no canonical occurrence in the graph (would
 *     point at a phantom node), OR
 *   - this task is not the canonical occurrence for its id — a dup
 *     loser shouldn't show lenses, the dup-id diagnostic is enough.
 *
 * Forward dangling edges (the target id is set in metadata but the
 * graph has no node for it) still render — with a "(missing)" suffix
 * and a no-op `tsk.codelens.missing` handler so a click pops an info
 * toast rather than silently failing.
 */
export function computeLensesForTask(
    task: TaskForLenses,
    fileUri: string,
    lookup: GraphLookup,
): LensDescriptor[] {
    const id = task.metadata.get('id');
    if (!id) return [];
    const node = lookup(id);
    if (!node) return [];
    // Canonical-occurrence gate — only the lex-lowest occurrence
    // renders lenses; dup losers get a diagnostic, not lenses.
    if (node.fileUri !== fileUri || node.line !== task.line) return [];

    const out: LensDescriptor[] = [];

    if (node.forward.parent !== undefined) {
        out.push(forwardLens(task.line, 'parent', node.forward.parent, 'tsk.goToParent', lookup));
    }
    if (node.forward.dependsOn !== undefined) {
        out.push(
            forwardLens(
                task.line,
                'dependsOn',
                node.forward.dependsOn,
                'tsk.goToDependsOn',
                lookup,
            ),
        );
    }
    if (node.forward.relatedTo !== undefined) {
        out.push(
            forwardLens(task.line, 'relatedTo', node.forward.relatedTo, 'tsk.goToRelated', lookup),
        );
    }

    if (node.inverse.children.length > 0) {
        out.push(
            inverseLens(
                task.line,
                'children',
                node.inverse.children,
                'tsk.findAllChildren',
                fileUri,
            ),
        );
    }
    if (node.inverse.dependents.length > 0) {
        out.push(
            inverseLens(
                task.line,
                'dependents',
                node.inverse.dependents,
                'tsk.findAllDependents',
                fileUri,
            ),
        );
    }
    if (node.inverse.related.length > 0) {
        out.push(
            inverseLens(task.line, 'related', node.inverse.related, 'tsk.findAllRelated', fileUri),
        );
    }

    return out;
}

function forwardLens(
    line: number,
    label: ForwardLabel,
    targetId: string,
    command: string,
    lookup: GraphLookup,
): LensDescriptor {
    const target = lookup(targetId);
    if (target === undefined) {
        return {
            line,
            title: `$(${CODICONS.missing}) ${label}: ${targetId} (missing)`,
            command: 'tsk.codelens.missing',
            args: [targetId, label],
        };
    }
    return {
        line,
        title: `$(${CODICONS[label]}) ${label}: ${targetId}`,
        command,
        args: [targetId],
    };
}

function inverseLens(
    line: number,
    label: InverseLabel,
    ids: readonly string[],
    command: string,
    sourceUri: string,
): LensDescriptor {
    return {
        line,
        title: `$(${CODICONS[label]}) ${label}: ${ids.length}`,
        command,
        args: [sourceUri, line, [...ids]],
    };
}
