import { describe, expect, it } from 'vitest';
import { buildGraph, type TaskRelationshipInput } from './graph';
import { GraphService } from './graph-service';

function task(
    id: string,
    fileUri: string,
    line: number,
    forward: Partial<Pick<TaskRelationshipInput, 'parent' | 'dependsOn' | 'relatedTo'>> = {},
): TaskRelationshipInput {
    return { id, fileUri, line, ...forward };
}

describe('GraphService — basics', () => {
    it('starts empty', () => {
        const svc = new GraphService();
        expect(svc.getGraph().size).toBe(0);
        expect(svc.getDuplicates()).toEqual([]);
        expect(svc.counts()).toEqual({ nodes: 0, occurrences: 0, duplicateIds: 0 });
    });

    it('applies a single file and exposes its nodes', () => {
        const svc = new GraphService();
        svc.applyFileTasks('a.tsk', [
            task('a', 'a.tsk', 1),
            task('b', 'a.tsk', 2, { parent: 'a' }),
        ]);
        expect(svc.getNode('a')?.inverse.children).toEqual(['b']);
        expect(svc.getNode('b')?.forward.parent).toBe('a');
        expect(svc.counts()).toEqual({ nodes: 2, occurrences: 2, duplicateIds: 0 });
    });

    it('drops file contribution on `removeFile`', () => {
        const svc = new GraphService();
        svc.applyFileTasks('a.tsk', [task('a', 'a.tsk', 1)]);
        svc.removeFile('a.tsk');
        expect(svc.getNode('a')).toBeUndefined();
        expect(svc.counts().nodes).toBe(0);
    });

    it('`purge` resets every internal index', () => {
        const svc = new GraphService();
        svc.applyFileTasks('a.tsk', [task('a', 'a.tsk', 1)]);
        svc.applyFileTasks('b.tsk', [task('b', 'b.tsk', 1, { parent: 'a' })]);
        svc.purge();
        expect(svc.getGraph().size).toBe(0);
        expect(svc.getDuplicates()).toEqual([]);
        expect(svc.counts()).toEqual({ nodes: 0, occurrences: 0, duplicateIds: 0 });
    });
});

describe('GraphService — scoped invalidation', () => {
    it('a file change does not disturb other files edges', () => {
        const svc = new GraphService();
        svc.applyFileTasks('a.tsk', [task('a', 'a.tsk', 1)]);
        svc.applyFileTasks('b.tsk', [task('b', 'b.tsk', 1, { parent: 'a' })]);
        svc.applyFileTasks('c.tsk', [task('c', 'c.tsk', 1, { parent: 'a' })]);
        // Now b.tsk gets rescanned to swap b's parent target.
        svc.applyFileTasks('b.tsk', [task('b', 'b.tsk', 1, { parent: 'c' })]);
        // a.tsk and c.tsk indices untouched; only b's contribution changed.
        expect(svc.getNode('a')?.inverse.children).toEqual(['c']);
        expect(svc.getNode('c')?.inverse.children).toEqual(['b']);
    });

    it('updating a file with new tasks replaces (does not append) prior contribution', () => {
        const svc = new GraphService();
        svc.applyFileTasks('a.tsk', [task('a', 'a.tsk', 1), task('b', 'a.tsk', 2)]);
        svc.applyFileTasks('a.tsk', [task('a', 'a.tsk', 1)]); // dropped `b`
        expect(svc.getNode('b')).toBeUndefined();
        expect(svc.counts()).toEqual({ nodes: 1, occurrences: 1, duplicateIds: 0 });
    });

    it('canonical winner is preserved when a different file is rescanned', () => {
        const svc = new GraphService();
        // `dup` lives in both files; lexicographically lowest wins.
        svc.applyFileTasks('a.tsk', [task('dup', 'a.tsk', 5)]);
        svc.applyFileTasks('b.tsk', [task('dup', 'b.tsk', 3)]);
        expect(svc.getNode('dup')?.fileUri).toBe('a.tsk');
        // Rescan an unrelated file — canonical winner is unchanged.
        svc.applyFileTasks('c.tsk', [task('other', 'c.tsk', 1)]);
        expect(svc.getNode('dup')?.fileUri).toBe('a.tsk');
    });

    it('removing the canonical occurrence promotes the next-lowest', () => {
        const svc = new GraphService();
        svc.applyFileTasks('a.tsk', [task('dup', 'a.tsk', 5)]);
        svc.applyFileTasks('b.tsk', [task('dup', 'b.tsk', 3)]);
        expect(svc.getNode('dup')?.fileUri).toBe('a.tsk');
        // Remove a.tsk → b.tsk's occurrence becomes canonical.
        svc.removeFile('a.tsk');
        expect(svc.getNode('dup')?.fileUri).toBe('b.tsk');
        expect(svc.getDuplicates()).toEqual([]); // no longer a duplicate
    });
});

describe('GraphService — duplicate-id tracking', () => {
    it('reports duplicates across multiple files', () => {
        const svc = new GraphService();
        svc.applyFileTasks('a.tsk', [task('dup', 'a.tsk', 1)]);
        svc.applyFileTasks('b.tsk', [task('dup', 'b.tsk', 2)]);
        const dups = svc.getDuplicates();
        expect(dups).toHaveLength(1);
        expect(dups[0]?.id).toBe('dup');
        expect(dups[0]?.occurrences).toEqual([
            { fileUri: 'a.tsk', line: 1 },
            { fileUri: 'b.tsk', line: 2 },
        ]);
    });

    it('clears duplicates when one of the conflicting files is rescanned without the id', () => {
        const svc = new GraphService();
        svc.applyFileTasks('a.tsk', [task('dup', 'a.tsk', 1)]);
        svc.applyFileTasks('b.tsk', [task('dup', 'b.tsk', 2)]);
        expect(svc.getDuplicates()).toHaveLength(1);
        svc.applyFileTasks('b.tsk', []); // b loses its `dup` task
        expect(svc.getDuplicates()).toEqual([]);
        expect(svc.getNode('dup')?.fileUri).toBe('a.tsk');
    });

    it('handles a single id in three files', () => {
        const svc = new GraphService();
        svc.applyFileTasks('a.tsk', [task('dup', 'a.tsk', 10)]);
        svc.applyFileTasks('b.tsk', [task('dup', 'b.tsk', 20)]);
        svc.applyFileTasks('c.tsk', [task('dup', 'c.tsk', 30)]);
        const dups = svc.getDuplicates();
        expect(dups).toHaveLength(1);
        expect(dups[0]?.occurrences).toHaveLength(3);
    });
});

describe('GraphService — invariant against pure buildGraph', () => {
    it('snapshot equals `buildGraph(allOccurrences)` after a multi-step sequence', () => {
        const svc = new GraphService();
        // A scripted sequence that exercises add / replace / dup / clear / unrelated change.
        svc.applyFileTasks('a.tsk', [
            task('root', 'a.tsk', 1),
            task('child', 'a.tsk', 2, { parent: 'root' }),
        ]);
        svc.applyFileTasks('b.tsk', [
            task('sibling', 'b.tsk', 1, { parent: 'root' }),
            task('dup', 'b.tsk', 2),
        ]);
        svc.applyFileTasks('c.tsk', [task('dup', 'c.tsk', 1, { dependsOn: 'root' })]);
        svc.applyFileTasks('a.tsk', [
            // Drop `child`, keep `root`, introduce a new dangling edge.
            task('root', 'a.tsk', 1, { relatedTo: 'unknown' }),
        ]);
        svc.removeFile('b.tsk');

        // We can't introspect the service's private occurrence index, so the
        // expectation is constructed by replaying the final inputs through
        // `buildGraph` directly. The service's job is to converge to the
        // same end-state regardless of the mutation sequence that got there.
        const finalA: TaskRelationshipInput[] = [
            task('root', 'a.tsk', 1, { relatedTo: 'unknown' }),
        ];
        const finalC: TaskRelationshipInput[] = [task('dup', 'c.tsk', 1, { dependsOn: 'root' })];
        const expected = buildGraph([...finalA, ...finalC]);

        // Compare graph contents node-by-node.
        expect([...svc.getGraph().keys()].sort()).toEqual([...expected.graph.keys()].sort());
        for (const id of expected.graph.keys()) {
            expect(svc.getNode(id)).toEqual(expected.graph.get(id));
        }
        expect(svc.getDuplicates()).toEqual(expected.duplicates);
    });

    it('many random-shape sequences agree with `buildGraph` of the same final inputs', () => {
        // Hand-crafted scenarios — each entry is { steps, finalInputs }.
        const scenarios: Array<{
            steps: Array<{ file: string; tasks: TaskRelationshipInput[] } | { remove: string }>;
            finalInputs: TaskRelationshipInput[];
        }> = [
            {
                steps: [
                    {
                        file: 'a.tsk',
                        tasks: [task('x', 'a.tsk', 1, { parent: 'y' }), task('y', 'a.tsk', 2)],
                    },
                    { remove: 'a.tsk' },
                    {
                        file: 'b.tsk',
                        tasks: [task('z', 'b.tsk', 1)],
                    },
                ],
                finalInputs: [task('z', 'b.tsk', 1)],
            },
            {
                steps: [
                    {
                        file: 'a.tsk',
                        tasks: [task('dup', 'a.tsk', 1, { parent: 'a-parent' })],
                    },
                    {
                        file: 'b.tsk',
                        tasks: [task('dup', 'b.tsk', 1, { parent: 'b-parent' })],
                    },
                    {
                        file: 'c.tsk',
                        tasks: [task('a-parent', 'c.tsk', 1), task('b-parent', 'c.tsk', 2)],
                    },
                    // Rescan a to drop the dup occurrence — b's becomes canonical.
                    { file: 'a.tsk', tasks: [] },
                ],
                finalInputs: [
                    task('dup', 'b.tsk', 1, { parent: 'b-parent' }),
                    task('a-parent', 'c.tsk', 1),
                    task('b-parent', 'c.tsk', 2),
                ],
            },
        ];

        for (const scenario of scenarios) {
            const svc = new GraphService();
            for (const step of scenario.steps) {
                if ('remove' in step) {
                    svc.removeFile(step.remove);
                } else {
                    svc.applyFileTasks(step.file, step.tasks);
                }
            }
            const expected = buildGraph(scenario.finalInputs);
            expect([...svc.getGraph().keys()].sort()).toEqual([...expected.graph.keys()].sort());
            for (const id of expected.graph.keys()) {
                expect(svc.getNode(id)).toEqual(expected.graph.get(id));
            }
            expect(svc.getDuplicates()).toEqual(expected.duplicates);
        }
    });
});

describe('GraphService — broken forward edges', () => {
    it('returns an empty report when every forward edge resolves', () => {
        const svc = new GraphService();
        svc.applyFileTasks('a.tsk', [
            task('a', 'a.tsk', 1),
            task('b', 'a.tsk', 2, { parent: 'a' }),
        ]);
        expect(svc.getBrokenForwardEdges()).toEqual([]);
    });

    it('reports a parent edge whose target id is not in the workspace', () => {
        const svc = new GraphService();
        svc.applyFileTasks('a.tsk', [task('b', 'a.tsk', 2, { parent: 'ghost' })]);
        expect(svc.getBrokenForwardEdges()).toEqual([
            {
                sourceId: 'b',
                sourceFile: 'a.tsk',
                sourceLine: 2,
                key: 'parent',
                targetId: 'ghost',
            },
        ]);
    });

    it('emits one report per broken key on a task with multiple broken refs', () => {
        const svc = new GraphService();
        svc.applyFileTasks('a.tsk', [
            task('multi', 'a.tsk', 0, {
                parent: 'missing-p',
                dependsOn: 'missing-d',
                relatedTo: 'missing-r',
            }),
        ]);
        const reports = svc.getBrokenForwardEdges();
        expect(reports).toHaveLength(3);
        expect(reports.map((r) => r.key).sort()).toEqual(['dependsOn', 'parent', 'relatedTo']);
        for (const r of reports) {
            expect(r.sourceId).toBe('multi');
            expect(r.sourceFile).toBe('a.tsk');
            expect(r.sourceLine).toBe(0);
        }
    });

    it('does NOT report an edge once the target is added by another file', () => {
        const svc = new GraphService();
        svc.applyFileTasks('a.tsk', [task('child', 'a.tsk', 1, { parent: 'p' })]);
        expect(svc.getBrokenForwardEdges()).toHaveLength(1);
        svc.applyFileTasks('b.tsk', [task('p', 'b.tsk', 0)]);
        expect(svc.getBrokenForwardEdges()).toEqual([]);
    });

    it('re-reports after the target file is removed', () => {
        const svc = new GraphService();
        svc.applyFileTasks('a.tsk', [task('child', 'a.tsk', 1, { parent: 'p' })]);
        svc.applyFileTasks('b.tsk', [task('p', 'b.tsk', 0)]);
        expect(svc.getBrokenForwardEdges()).toEqual([]);
        svc.removeFile('b.tsk');
        expect(svc.getBrokenForwardEdges()).toHaveLength(1);
    });

    it('walks the canonical graph — dup losers do not double-report', () => {
        // Two files declare the same `child` id with `@parent:p`. Only one
        // wins canonicality (lex-lowest file), so only one broken-ref
        // surfaces, not two.
        const svc = new GraphService();
        svc.applyFileTasks('b.tsk', [task('child', 'b.tsk', 1, { parent: 'p' })]);
        svc.applyFileTasks('a.tsk', [task('child', 'a.tsk', 2, { parent: 'p' })]);
        const reports = svc.getBrokenForwardEdges();
        expect(reports).toHaveLength(1);
        // canonical winner is the lex-lowest file (a.tsk).
        expect(reports[0]?.sourceFile).toBe('a.tsk');
    });
});
