import { describe, expect, it } from 'vitest';
import { computeLensesForTask, type GraphLookup, type TaskForLenses } from './codelens-logic';
import type { GraphNode } from './graph';

function node(
    id: string,
    fileUri: string,
    line: number,
    overrides: Partial<{
        forward: GraphNode['forward'];
        inverse: Partial<GraphNode['inverse']>;
    }> = {},
): GraphNode {
    return {
        id,
        fileUri,
        line,
        forward: overrides.forward ?? {},
        inverse: {
            children: overrides.inverse?.children ?? [],
            dependents: overrides.inverse?.dependents ?? [],
            related: overrides.inverse?.related ?? [],
        },
    };
}

function lookupFrom(nodes: GraphNode[]): GraphLookup {
    const map = new Map(nodes.map((n) => [n.id, n]));
    return (id) => map.get(id);
}

function task(
    id: string | undefined,
    line: number,
    extras: Record<string, string | null> = {},
): TaskForLenses {
    const metadata = new Map<string, string | null>();
    if (id !== undefined) metadata.set('id', id);
    for (const [k, v] of Object.entries(extras)) metadata.set(k, v);
    return { line, metadata };
}

describe('computeLensesForTask — gating', () => {
    it('returns nothing for a task with no @id', () => {
        const lookup = lookupFrom([]);
        expect(computeLensesForTask(task(undefined, 0), 'a.tsk', lookup)).toEqual([]);
    });

    it('returns nothing when the id has no graph node', () => {
        const lookup = lookupFrom([]);
        expect(computeLensesForTask(task('a', 0), 'a.tsk', lookup)).toEqual([]);
    });

    it('returns nothing when this is not the canonical occurrence (dup loser)', () => {
        // Canonical lives on a.tsk:0, but this task is on b.tsk:0 with the same id.
        const lookup = lookupFrom([node('dup', 'a.tsk', 0)]);
        expect(computeLensesForTask(task('dup', 0), 'b.tsk', lookup)).toEqual([]);
    });

    it('returns nothing when canonical line differs (same file, different line)', () => {
        const lookup = lookupFrom([node('dup', 'a.tsk', 0)]);
        expect(computeLensesForTask(task('dup', 5), 'a.tsk', lookup)).toEqual([]);
    });
});

describe('computeLensesForTask — forward edges', () => {
    it('renders a parent lens pointing at the navigate command', () => {
        const lookup = lookupFrom([
            node('child', 'a.tsk', 0, { forward: { parent: 'root' } }),
            node('root', 'a.tsk', 5),
        ]);
        const lenses = computeLensesForTask(task('child', 0), 'a.tsk', lookup);
        expect(lenses).toEqual([
            {
                line: 0,
                title: '$(arrow-up) parent: root',
                command: 'tsk.goToParent',
                args: ['root'],
            },
        ]);
    });

    it('renders all three forward edges in declared order', () => {
        const lookup = lookupFrom([
            node('source', 'a.tsk', 0, {
                forward: { parent: 'p', dependsOn: 'd', relatedTo: 'r' },
            }),
            node('p', 'a.tsk', 1),
            node('d', 'a.tsk', 2),
            node('r', 'a.tsk', 3),
        ]);
        const lenses = computeLensesForTask(task('source', 0), 'a.tsk', lookup);
        expect(lenses.map((l) => l.command)).toEqual([
            'tsk.goToParent',
            'tsk.goToDependsOn',
            'tsk.goToRelated',
        ]);
    });

    it('marks a dangling forward edge with `(missing)` and routes to the missing handler', () => {
        const lookup = lookupFrom([node('orphan', 'a.tsk', 0, { forward: { parent: 'gone' } })]);
        const lenses = computeLensesForTask(task('orphan', 0), 'a.tsk', lookup);
        expect(lenses).toEqual([
            {
                line: 0,
                title: '$(warning) parent: gone (missing)',
                command: 'tsk.codelens.missing',
                args: ['gone', 'parent'],
            },
        ]);
    });
});

describe('computeLensesForTask — inverse edges', () => {
    it('renders a `children: N` lens with the source uri and child ids', () => {
        const lookup = lookupFrom([
            node('root', 'a.tsk', 0, { inverse: { children: ['c1', 'c2', 'c3'] } }),
            node('c1', 'b.tsk', 0),
            node('c2', 'b.tsk', 1),
            node('c3', 'b.tsk', 2),
        ]);
        const lenses = computeLensesForTask(task('root', 0), 'a.tsk', lookup);
        expect(lenses).toEqual([
            {
                line: 0,
                title: '$(arrow-down) children: 3',
                command: 'tsk.findAllChildren',
                args: ['a.tsk', 0, ['c1', 'c2', 'c3']],
            },
        ]);
    });

    it('omits inverse lenses with empty arrays', () => {
        const lookup = lookupFrom([node('isolated', 'a.tsk', 0)]);
        expect(computeLensesForTask(task('isolated', 0), 'a.tsk', lookup)).toEqual([]);
    });

    it('routes each inverse-edge kind to its own command', () => {
        const lookup = lookupFrom([
            node('target', 'a.tsk', 0, {
                inverse: { children: ['c'], dependents: ['d1', 'd2'], related: ['r'] },
            }),
            node('c', 'b.tsk', 0),
            node('d1', 'b.tsk', 1),
            node('d2', 'b.tsk', 2),
            node('r', 'b.tsk', 3),
        ]);
        const lenses = computeLensesForTask(task('target', 0), 'a.tsk', lookup);
        expect(lenses.map((l) => l.command)).toEqual([
            'tsk.findAllChildren',
            'tsk.findAllDependents',
            'tsk.findAllRelated',
        ]);
    });
});

describe('computeLensesForTask — codicons', () => {
    it('prepends the documented codicon per edge type', () => {
        const lookup = lookupFrom([
            node('source', 'a.tsk', 0, {
                forward: { parent: 'p', dependsOn: 'd', relatedTo: 'r' },
                inverse: { children: ['c'], dependents: ['x'], related: ['y'] },
            }),
            node('p', 'a.tsk', 1),
            node('d', 'a.tsk', 2),
            node('r', 'a.tsk', 3),
            node('c', 'a.tsk', 4),
            node('x', 'a.tsk', 5),
            node('y', 'a.tsk', 6),
        ]);
        const titles = computeLensesForTask(task('source', 0), 'a.tsk', lookup).map((l) => l.title);
        expect(titles).toEqual([
            '$(arrow-up) parent: p',
            '$(arrow-right) dependsOn: d',
            '$(link) relatedTo: r',
            '$(arrow-down) children: 1',
            '$(arrow-left) dependents: 1',
            '$(references) related: 1',
        ]);
    });

    it('uses the warning codicon on dangling forward edges', () => {
        const lookup = lookupFrom([node('orphan', 'a.tsk', 0, { forward: { dependsOn: 'gone' } })]);
        const titles = computeLensesForTask(task('orphan', 0), 'a.tsk', lookup).map((l) => l.title);
        expect(titles).toEqual(['$(warning) dependsOn: gone (missing)']);
    });
});

describe('computeLensesForTask — mixed', () => {
    it('emits forward then inverse lenses on a node with both', () => {
        const lookup = lookupFrom([
            node('hub', 'a.tsk', 0, {
                forward: { parent: 'root' },
                inverse: { children: ['c'] },
            }),
            node('root', 'a.tsk', 1),
            node('c', 'a.tsk', 2),
        ]);
        const lenses = computeLensesForTask(task('hub', 0), 'a.tsk', lookup);
        expect(lenses.map((l) => l.title)).toEqual([
            '$(arrow-up) parent: root',
            '$(arrow-down) children: 1',
        ]);
    });
});
