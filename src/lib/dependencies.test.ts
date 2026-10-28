import { describe, expect, it } from 'vitest';
import {
    blockers,
    cycleIfDepends,
    dependencies,
    dependencyLayers,
    dependents,
    isReady,
    readyTasks,
} from './dependencies';
import { buildTaskTree, type TaskTree, type TreeNode, withOutside } from './task-tree';

/** A plan: phase two waits on phase one; its step waits on `side` as well; `gone` isn't in the file. */
const PLAN = [
    '- [/] plan <!-- @id:plan -->',
    '  - [ ] phase one <!-- @id:one -->',
    '    - [x] one done <!-- @id:one-a -->',
    '    - [ ] one left <!-- @id:one-b -->',
    '  - [ ] phase two <!-- @id:two @dependsOn:one -->',
    '    - [ ] two step <!-- @id:two-a @dependsOn:side -->',
    '  - [ ] side job <!-- @id:side -->',
    '  - [ ] finished dep <!-- @id:fin @dependsOn:one-a -->',
    '  - [ ] stranded <!-- @id:str @dependsOn:gone -->',
];

const tree = buildTaskTree(PLAN);
const at = (t: TaskTree, id: string): TreeNode => {
    const n = t.byId.get(id);
    if (!n) throw new Error(`no ${id}`);
    return n;
};
const ids = (nodes: readonly TreeNode[]) => nodes.map((n) => n.id);

describe('dependencies and dependents', () => {
    it('resolves each @dependsOn id, keeping one the file lacks as just its id', () => {
        expect(dependencies(tree, at(tree, 'two')).map((d) => [d.id, d.node?.id])).toEqual([
            ['one', 'one'],
        ]);
        expect(dependencies(tree, at(tree, 'str'))).toEqual([{ id: 'gone', node: undefined }]);
    });

    it('lists what names a task, in file order', () => {
        expect(ids(dependents(tree, at(tree, 'one')))).toEqual(['two']);
        expect(ids(dependents(tree, at(tree, 'side')))).toEqual(['two-a']);
        expect(dependents(tree, at(tree, 'plan'))).toEqual([]);
    });
});

describe('blockers', () => {
    it('inherits the wait of every task above, and names where it came from', () => {
        expect(blockers(tree, at(tree, 'two-a')).map((b) => [b.id, b.via.id])).toEqual([
            ['one', 'two'],
            ['side', 'two-a'],
        ]);
    });

    it('lets a finished dependency through, and holds on a missing one', () => {
        expect(blockers(tree, at(tree, 'fin'))).toEqual([]);
        expect(blockers(tree, at(tree, 'str')).map((b) => b.id)).toEqual(['gone']);
    });
});

describe('ready', () => {
    it('is the [ ] tasks nothing blocks, in file order', () => {
        expect(ids(readyTasks(tree))).toEqual(['one', 'one-b', 'side', 'fin']);
        expect(isReady(tree, at(tree, 'plan'))).toBe(false); // in progress, not to start
    });

    it('stays inside a subtree when given one', () => {
        expect(ids(readyTasks(tree, at(tree, 'one')))).toEqual(['one', 'one-b']);
    });

    it('opens up once the dependency is done', () => {
        const done = buildTaskTree(
            PLAN.map((l) =>
                l.replace('[ ] phase one', '[x] phase one').replace('[ ] side', '[x] side'),
            ),
        );
        expect(ids(readyTasks(done))).toContain('two-a');
    });
});

describe('cycleIfDepends', () => {
    it('finds the chain back to the task, or to a task inside it', () => {
        expect(ids(cycleIfDepends(tree, at(tree, 'one'), at(tree, 'two')) ?? [])).toEqual([
            'two',
            'one',
        ]);
        expect(ids(cycleIfDepends(tree, at(tree, 'side'), at(tree, 'two-a')) ?? [])).toEqual([
            'two-a',
            'side',
        ]);
        expect(ids(cycleIfDepends(tree, at(tree, 'plan'), at(tree, 'side')) ?? [])).toEqual([
            'side',
        ]);
    });

    it('is undefined when the edge closes no loop', () => {
        expect(cycleIfDepends(tree, at(tree, 'side'), at(tree, 'one'))).toBeUndefined();
        expect(cycleIfDepends(tree, at(tree, 'two-a'), at(tree, 'plan'))).toBeUndefined();
    });
});

describe('dependencyLayers', () => {
    it('steps the open tasks taking part in a dependency by what they wait on', () => {
        const { steps, cyclic } = dependencyLayers(tree);
        // `fin` names only a finished task, so it's in step 0 with the rest that can start;
        // `two-a` waits on what `two` waits on (and `side`), so they share a step.
        expect(steps.map(ids)).toEqual([
            ['one', 'side', 'fin'],
            ['two', 'two-a', 'str'],
        ]);
        expect(cyclic).toEqual([]);
    });

    it('sets a loop, and what waits on it, apart', () => {
        const loop = buildTaskTree([
            '- [ ] a <!-- @id:a @dependsOn:b -->',
            '- [ ] b <!-- @id:b @dependsOn:a -->',
            '- [ ] c <!-- @id:c @dependsOn:a -->',
            '- [ ] d <!-- @id:d -->',
            '- [ ] e <!-- @id:e @dependsOn:d -->',
        ]);
        const { steps, cyclic } = dependencyLayers(loop);
        expect(steps.map(ids)).toEqual([['d'], ['e']]);
        expect(ids(cyclic)).toEqual(['a', 'b', 'c']);
    });
});

describe('dependencies in other files', () => {
    const backlog = buildTaskTree([
        '- [ ] open item <!-- @id:bopen -->',
        '- [x] done item <!-- @id:bdone -->',
        '- [ ] waits on ours <!-- @id:bwaits @dependsOn:mine -->',
        '- [ ] loops back <!-- @id:bloop @dependsOn:loopy -->',
    ]);
    const own = buildTaskTree([
        '- [ ] mine <!-- @id:mine -->',
        '- [ ] on open <!-- @id:o @dependsOn:bopen -->',
        '- [ ] on done <!-- @id:d @dependsOn:bdone -->',
        '- [ ] on nothing <!-- @id:n @dependsOn:nowhere -->',
        '- [ ] loopy <!-- @id:loopy -->',
    ]);
    const t = withOutside(own, [{ file: '/w/stack.tsk', tree: backlog }]);

    it('resolve, and block while open, as tasks in the file do; an id in no file still blocks', () => {
        expect(dependencies(t, at(t, 'o'))).toEqual([{ id: 'bopen', node: at(backlog, 'bopen') }]);
        expect(isReady(t, at(t, 'o'))).toBe(false);
        expect(isReady(t, at(t, 'd'))).toBe(true);
        expect(isReady(t, at(t, 'n'))).toBe(false);
        // Without the files beside it, both are ids the file doesn't have.
        expect(isReady(own, at(own, 'd'))).toBe(false);
    });

    it('count a task there that names one here among its dependents', () => {
        expect(dependents(t, at(t, 'mine'))).toEqual([at(backlog, 'bwaits')]);
    });

    it('are followed for loops', () => {
        expect(cycleIfDepends(t, at(t, 'loopy'), at(backlog, 'bloop'))?.map((n) => n.id)).toEqual([
            'bloop',
            'loopy',
        ]);
    });

    it("put the task there in the steps, before the file's task that waits on it", () => {
        const { steps } = dependencyLayers(t);
        const stepOf = (id: string) => steps.findIndex((s) => s.some((n) => n.id === id));
        expect(stepOf('bopen')).toBe(0);
        expect(stepOf('o')).toBe(1);
        expect(steps.flat().filter((n) => n.id === 'bdone')).toEqual([]);
    });
});
