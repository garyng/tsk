import { describe, expect, it } from 'vitest';
import { buildGraph, type TaskRelationshipInput } from './graph';

function task(
    id: string,
    fileUri: string,
    line: number,
    forward: Partial<
        Pick<TaskRelationshipInput, 'parent' | 'dependsOn' | 'relatedTo' | 'movedTo'>
    > = {},
): TaskRelationshipInput {
    return { id, fileUri, line, ...forward };
}

describe('buildGraph — basics', () => {
    it('returns an empty graph and no duplicates for empty input', () => {
        const { graph, duplicates } = buildGraph([]);
        expect(graph.size).toBe(0);
        expect(duplicates).toEqual([]);
    });

    it('builds a singleton node with no forward edges', () => {
        const { graph } = buildGraph([task('a', 'file:///x.tsk', 1)]);
        const node = graph.get('a');
        expect(node).toBeDefined();
        expect(node?.forward).toEqual({});
        expect(node?.inverse).toEqual({
            children: [],
            dependents: [],
            related: [],
            movedHereFrom: [],
        });
        expect(node?.fileUri).toBe('file:///x.tsk');
        expect(node?.line).toBe(1);
    });

    it('skips tasks with empty ids (the cache layer warns about them separately)', () => {
        const { graph, duplicates } = buildGraph([task('', 'file:///x.tsk', 1)]);
        expect(graph.size).toBe(0);
        expect(duplicates).toEqual([]);
    });

    it('records every forward edge on the source node', () => {
        const { graph } = buildGraph([
            task('a', 'f.tsk', 1, { parent: 'p', dependsOn: 'd', relatedTo: 'r', movedTo: 'm' }),
        ]);
        const node = graph.get('a');
        expect(node?.forward).toEqual({
            parent: 'p',
            dependsOn: 'd',
            relatedTo: 'r',
            movedTo: 'm',
        });
    });
});

describe('buildGraph — inverse edges', () => {
    it('populates `children` for the parent target', () => {
        const { graph } = buildGraph([
            task('a', 'f.tsk', 1, { parent: 'b' }),
            task('b', 'f.tsk', 2),
        ]);
        expect(graph.get('b')?.inverse.children).toEqual(['a']);
    });

    it('threads parent edges across a chain', () => {
        const { graph } = buildGraph([
            task('a', 'f.tsk', 1, { parent: 'b' }),
            task('b', 'f.tsk', 2, { parent: 'c' }),
            task('c', 'f.tsk', 3),
        ]);
        expect(graph.get('b')?.inverse.children).toEqual(['a']);
        expect(graph.get('c')?.inverse.children).toEqual(['b']);
    });

    it('sorts inverse `children` ascending by source id', () => {
        const { graph } = buildGraph([
            task('zoo', 'f.tsk', 1, { parent: 'p' }),
            task('alpha', 'f.tsk', 2, { parent: 'p' }),
            task('mid', 'f.tsk', 3, { parent: 'p' }),
            task('p', 'f.tsk', 4),
        ]);
        expect(graph.get('p')?.inverse.children).toEqual(['alpha', 'mid', 'zoo']);
    });

    it('populates `dependents` and `related` independently', () => {
        const { graph } = buildGraph([
            task('a', 'f.tsk', 1, { dependsOn: 'target' }),
            task('b', 'f.tsk', 2, { dependsOn: 'target' }),
            task('c', 'f.tsk', 3, { relatedTo: 'target' }),
            task('target', 'f.tsk', 4),
        ]);
        const target = graph.get('target');
        expect(target?.inverse.dependents).toEqual(['a', 'b']);
        expect(target?.inverse.related).toEqual(['c']);
        expect(target?.inverse.children).toEqual([]);
    });

    it('populates `movedHereFrom` for the movedTo target, sorted + independent', () => {
        const { graph } = buildGraph([
            task('zoo', 'f.tsk', 1, { movedTo: 'dest' }),
            task('alpha', 'f.tsk', 2, { movedTo: 'dest' }),
            task('dest', 'f.tsk', 3),
        ]);
        const dest = graph.get('dest');
        expect(dest?.inverse.movedHereFrom).toEqual(['alpha', 'zoo']);
        expect(dest?.inverse.children).toEqual([]);
        expect(graph.get('zoo')?.forward).toEqual({ movedTo: 'dest' });
    });
});

describe('buildGraph — dangling + cycles + self-loops', () => {
    it('keeps dangling forward edges on the source node', () => {
        const { graph } = buildGraph([task('a', 'f.tsk', 1, { parent: 'nope' })]);
        expect(graph.get('a')?.forward.parent).toBe('nope');
        expect(graph.has('nope')).toBe(false);
    });

    it('handles a self-loop (A.parent = A)', () => {
        const { graph } = buildGraph([task('a', 'f.tsk', 1, { parent: 'a' })]);
        const node = graph.get('a');
        expect(node?.forward.parent).toBe('a');
        expect(node?.inverse.children).toEqual(['a']);
    });

    it('handles a 2-cycle (A.parent = B, B.parent = A)', () => {
        const { graph } = buildGraph([
            task('a', 'f.tsk', 1, { parent: 'b' }),
            task('b', 'f.tsk', 2, { parent: 'a' }),
        ]);
        expect(graph.get('a')?.inverse.children).toEqual(['b']);
        expect(graph.get('b')?.inverse.children).toEqual(['a']);
    });
});

describe('buildGraph — duplicates + canonical winner', () => {
    it('reports a single duplicated id with both occurrences', () => {
        const { graph, duplicates } = buildGraph([
            task('dup', 'file:///a.tsk', 5),
            task('dup', 'file:///b.tsk', 9),
        ]);
        expect(graph.size).toBe(1);
        expect(duplicates).toEqual([
            {
                id: 'dup',
                occurrences: [
                    { fileUri: 'file:///a.tsk', line: 5 },
                    { fileUri: 'file:///b.tsk', line: 9 },
                ],
            },
        ]);
    });

    it('reports a 3-occurrence duplicate sorted by (fileUri, line)', () => {
        const { graph, duplicates } = buildGraph([
            task('dup', 'file:///z.tsk', 1),
            task('dup', 'file:///a.tsk', 50),
            task('dup', 'file:///a.tsk', 10),
        ]);
        expect(duplicates).toHaveLength(1);
        expect(duplicates[0]?.occurrences).toEqual([
            { fileUri: 'file:///a.tsk', line: 10 },
            { fileUri: 'file:///a.tsk', line: 50 },
            { fileUri: 'file:///z.tsk', line: 1 },
        ]);
        // Canonical winner is the lowest occurrence — `a.tsk:10`.
        expect(graph.get('dup')?.fileUri).toBe('file:///a.tsk');
        expect(graph.get('dup')?.line).toBe(10);
    });

    it('uses lexicographic fileUri ordering for canonical-winner choice', () => {
        const { graph } = buildGraph([
            task('dup', 'file:///b.tsk', 1, { parent: 'lateWinner' }),
            task('dup', 'file:///a.tsk', 99, { parent: 'earlyWinner' }),
        ]);
        // file:///a.tsk:99 wins despite the higher line number because
        // 'file:///a.tsk' < 'file:///b.tsk'. The winner's forward edges
        // are the ones that end up on the graph node.
        expect(graph.get('dup')?.fileUri).toBe('file:///a.tsk');
        expect(graph.get('dup')?.forward.parent).toBe('earlyWinner');
    });

    it('breaks ties on `line` when fileUri matches', () => {
        const { graph } = buildGraph([
            task('dup', 'f.tsk', 9),
            task('dup', 'f.tsk', 3),
            task('dup', 'f.tsk', 6),
        ]);
        expect(graph.get('dup')?.line).toBe(3);
    });

    it('honors only the winning task forward edges when duplicate has conflicting metadata', () => {
        const { graph } = buildGraph([
            task('dup', 'a.tsk', 1, { dependsOn: 'x' }),
            task('dup', 'b.tsk', 1, { dependsOn: 'y' }),
            task('x', 'a.tsk', 2),
            task('y', 'b.tsk', 2),
        ]);
        // dup's canonical occurrence is (a.tsk, 1) → dependsOn = x.
        expect(graph.get('dup')?.forward.dependsOn).toBe('x');
        expect(graph.get('x')?.inverse.dependents).toEqual(['dup']);
        expect(graph.get('y')?.inverse.dependents).toEqual([]);
    });

    it('returns an empty `duplicates` array when no ids are duplicated', () => {
        const { duplicates } = buildGraph([task('a', 'f.tsk', 1), task('b', 'f.tsk', 2)]);
        expect(duplicates).toEqual([]);
    });

    it('sorts the `duplicates` report alphabetically by id', () => {
        const { duplicates } = buildGraph([
            task('zeta', 'a.tsk', 1),
            task('zeta', 'a.tsk', 2),
            task('alpha', 'a.tsk', 3),
            task('alpha', 'a.tsk', 4),
            task('mid', 'a.tsk', 5),
            task('mid', 'a.tsk', 6),
        ]);
        expect(duplicates.map((d) => d.id)).toEqual(['alpha', 'mid', 'zeta']);
    });
});

describe('buildGraph — determinism', () => {
    it('Map iteration order follows canonical (fileUri, line) of each node', () => {
        const { graph } = buildGraph([
            task('a', 'b.tsk', 1),
            task('b', 'a.tsk', 10),
            task('c', 'a.tsk', 5),
        ]);
        // a.tsk:5 < a.tsk:10 < b.tsk:1, so the iteration order is c, b, a.
        expect([...graph.keys()]).toEqual(['c', 'b', 'a']);
    });
});
