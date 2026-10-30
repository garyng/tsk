import { describe, expect, it } from 'vitest';
import { parseLine } from './parser';
import { sessionFocus } from './session-focus';
import {
    addDependencies,
    addTask,
    delegateTask,
    finishTask,
    focusTask,
    handOverSession,
    linkTask,
    type OpsDeps,
    parkTask,
    removeDependencies,
    rewordTask,
    TaskOpError,
} from './task-ops';
import { buildTaskTree } from './task-tree';

/** Deterministic ids (`id00001`, …) and a clock that ticks one second per call (`nowMs` with the milliseconds). */
function fakeDeps(): OpsDeps {
    let n = 0;
    let t = Date.parse('2026-10-19T10:00:00Z');
    return {
        generateId: () => `id${String(++n).padStart(5, '0')}`,
        now: () => {
            t += 1000;
            return new Date(t).toISOString().replace('.000Z', '+00:00');
        },
        nowMs: () => {
            t += 1000;
            return new Date(t).toISOString().replace('Z', '+00:00');
        },
    };
}

const meta = (line: string | undefined) =>
    Object.fromEntries(parseLine(line ?? '')?.metadata ?? []);

describe('addTask', () => {
    it('appends a root task with @id + @created, before trailing blank lines', () => {
        const { lines, id } = addTask(
            ['- [ ] existing <!-- @id:e -->', ''],
            { text: 'new one', session: 's' },
            fakeDeps(),
        );
        expect(id).toBe('id00001');
        expect(lines).toEqual([
            '- [ ] existing <!-- @id:e -->',
            '- [ ] new one <!-- @id:id00001 @created:2026-10-19T10:00:01+00:00 @session:s -->',
            '',
        ]);
    });

    it('nests as the last child of the parent, after its whole block', () => {
        const { lines } = addTask(
            [
                '- [ ] p <!-- @id:p -->',
                '  - [ ] first <!-- @id:a -->',
                '    - note',
                '- [ ] next root <!-- @id:r -->',
            ],
            { text: 'second', parentId: 'p' },
            fakeDeps(),
        );
        expect(lines[3]).toMatch(/^ {2}- \[ \] second <!-- @id:id00001 /);
        expect(lines[4]).toBe('- [ ] next root <!-- @id:r -->');
    });

    it('starts and focuses a sidetrack', () => {
        const { lines, id } = addTask(
            ['- [/] p <!-- @id:p -->'],
            { text: 'detour', parentId: 'p', start: true, session: 's' },
            fakeDeps(),
        );
        expect(lines[1]).toMatch(/^ {2}- \[\/\] detour /);
        expect(meta(lines[1])).toMatchObject({
            id,
            session: 's',
            started: '2026-10-19T10:00:02+00:00',
            focused: '2026-10-19T10:00:03.000+00:00',
        });
    });

    it('hands a new task to an agent: started, with @agent and @session, never focused', () => {
        const { lines, id } = addTask(
            ['- [/] p <!-- @id:p -->'],
            { text: 'probe', parentId: 'p', agent: 'alpha', session: 's' },
            fakeDeps(),
        );
        expect(lines[1]).toMatch(/^ {2}- \[\/\] probe /);
        expect(meta(lines[1])).toMatchObject({ id, session: 's', agent: 'alpha' });
        expect(meta(lines[1])).not.toHaveProperty('focused');
    });

    it('goes flat with @parent past the nesting cap, keeping siblings in order', () => {
        const deps = fakeDeps();
        let lines = [
            '- [ ] l0 <!-- @id:l0 -->',
            '  - [ ] l1 <!-- @id:l1 -->',
            '    - [ ] l2 <!-- @id:l2 -->',
            '      - [ ] l3, at the cap <!-- @id:l3 -->',
        ];
        lines = addTask(lines, { text: 'first past the cap', parentId: 'l3' }, deps).lines;
        lines = addTask(lines, { text: 'second past the cap', parentId: 'l3' }, deps).lines;
        lines = addTask(lines, { text: 'its child', parentId: 'id00001' }, deps).lines;
        expect(lines.slice(4).map((l) => l.replace(/ <!--.*/, ''))).toEqual([
            '      - [ ] first past the cap',
            '      - [ ] its child',
            '      - [ ] second past the cap',
        ]);
        expect(meta(lines[4]).parent).toBe('l3');
        expect(meta(lines[5]).parent).toBe('id00001');
        const tree = buildTaskTree(lines);
        expect(tree.byId.get('l3')?.children.map((c) => c.id)).toEqual(['id00001', 'id00002']);
    });

    it('never reuses an id already in the file', () => {
        const { id } = addTask(['- [ ] taken <!-- @id:id00001 -->'], { text: 'x' }, fakeDeps());
        expect(id).toBe('id00002');
    });

    it('rejects empty text, text that is already a task line, and an unknown parent', () => {
        expect(() => addTask([], { text: '  ' }, fakeDeps())).toThrow(TaskOpError);
        expect(() => addTask([], { text: '- [ ] whole line' }, fakeDeps())).toThrow(
            /already reads as a task/,
        );
        expect(() => addTask([], { text: 'x', parentId: 'nope' }, fakeDeps())).toThrow(
            /no task with @id:nope/,
        );
    });

    it('collapses newlines in the text onto one line', () => {
        const { lines } = addTask([], { text: 'two\nlines' }, fakeDeps());
        expect(lines).toHaveLength(1);
        expect(parseLine(lines[0] as string)?.content).toBe('two lines');
    });
});

describe('focus, finish and park', () => {
    const start = ['- [ ] p <!-- @id:p -->', '  - [ ] c <!-- @id:c -->'];

    it('focus starts the task and stamps who and when; re-focusing keeps @started', () => {
        const deps = fakeDeps();
        const once = focusTask(start, 'c', 's', deps).lines;
        const twice = focusTask(once, 'c', 's2', deps).lines;
        expect(meta(twice[1])).toMatchObject({
            started: meta(once[1]).started,
            session: 's2',
            focused: '2026-10-19T10:00:03.000+00:00',
        });
    });

    it('the later of two focuses in the same second wins, even when it is the parent', () => {
        let t = Date.parse('2026-10-19T10:00:00Z');
        const tick = () => {
            t += 100;
            return new Date(t).toISOString();
        };
        const deps: OpsDeps = {
            generateId: () => 'x',
            now: () => tick().replace(/\.\d{3}Z$/, '+00:00'),
            nowMs: () => tick().replace('Z', '+00:00'),
        };
        let lines = focusTask(start, 'c', 's', deps).lines;
        lines = focusTask(lines, 'p', 's', deps).lines;
        expect(sessionFocus(buildTaskTree(lines), 's')?.id).toBe('p');
    });

    it('done is set-only: finishing a finished task changes nothing', () => {
        const deps = fakeDeps();
        const done = finishTask(start, 'c', 'completed', deps);
        expect(done.lines[1]).toMatch(/^ {2}- \[x\] c .*@completed:/);
        expect(finishTask(done.lines, 'c', 'completed', deps).changed).toBe(false);
    });

    it('done on the focus hands focus back to the parent', () => {
        const deps = fakeDeps();
        let lines = focusTask(start, 'p', 's', deps).lines;
        lines = addTask(
            lines,
            { text: 'detour', parentId: 'c', start: true, session: 's' },
            deps,
        ).lines;
        expect(sessionFocus(buildTaskTree(lines), 's')?.task.content).toBe('detour');
        lines = finishTask(lines, 'id00001', 'completed', deps).lines;
        expect(sessionFocus(buildTaskTree(lines), 's')?.id).toBe('p');
    });

    it('park returns an in-progress task to [ ] without @started or @focused', () => {
        const deps = fakeDeps();
        const parked = parkTask(focusTask(start, 'c', 's', deps).lines, 'c');
        expect(parked.lines[1]).toBe('  - [ ] c <!-- @id:c @session:s -->');
        expect(parkTask(parked.lines, 'c').changed).toBe(false);
        expect(() => parkTask(finishTask(start, 'c', 'completed', deps).lines, 'c')).toThrow(
            /\[x\]; only an in-progress task can be parked/,
        );
    });
});

describe('delegateTask', () => {
    const start = [
        '- [/] p <!-- @id:p @session:s @focused:2026-10-19T09:00:00+00:00 -->',
        '  - [ ] c <!-- @id:c -->',
    ];

    it("starts the task for the agent and leaves the session's focus where it was", () => {
        const { lines } = delegateTask(start, 'c', 'alpha', 's', fakeDeps());
        expect(meta(lines[1])).toMatchObject({
            session: 's',
            agent: 'alpha',
            started: '2026-10-19T10:00:01+00:00',
        });
        expect(meta(lines[1])).not.toHaveProperty('focused');
        expect(sessionFocus(buildTaskTree(lines), 's')?.id).toBe('p');
    });

    it('hands the focus itself over, the focus falling back to its parent', () => {
        const deps = fakeDeps();
        const focused = focusTask(start, 'c', 's', deps).lines;
        const { lines } = delegateTask(focused, 'c', 'alpha', 's', deps);
        expect(sessionFocus(buildTaskTree(lines), 's')?.id).toBe('p');
    });

    it('moves a task to another agent, and changes nothing when it already has it', () => {
        const deps = fakeDeps();
        const once = delegateTask(start, 'c', 'alpha', 's', deps).lines;
        expect(delegateTask(once, 'c', 'alpha', 's', deps).changed).toBe(false);
        expect(meta(delegateTask(once, 'c', 'beta', 's', deps).lines[1]).agent).toBe('beta');
    });

    it('focus takes it back and park leaves it for later, each dropping @agent', () => {
        const deps = fakeDeps();
        const handed = delegateTask(start, 'c', 'alpha', 's', deps).lines;
        expect(meta(focusTask(handed, 'c', 's', deps).lines[1])).not.toHaveProperty('agent');
        expect(parkTask(handed, 'c').lines[1]).toBe('  - [ ] c <!-- @id:c @session:s -->');
    });

    it('refuses a name that is not one word, on add too', () => {
        for (const name of ['', 'two words', 'a-->b', '-x']) {
            expect(() => delegateTask(start, 'c', name, 's', fakeDeps())).toThrow(TaskOpError);
            expect(() =>
                addTask(start, { text: 't', agent: name, session: 's' }, fakeDeps()),
            ).toThrow(/agent name/);
        }
    });
});

describe('addDependencies / removeDependencies and linkTask', () => {
    const lines = ['- [ ] a <!-- @id:a -->', '- [ ] b <!-- @id:b -->', '- [ ] c <!-- @id:c -->'];

    it('appends to @dependsOn in order, skipping one already there', () => {
        const once = addDependencies(lines, 'a', ['b']);
        expect(meta(once.lines[0]).dependsOn).toBe('b');
        const twice = addDependencies(once.lines, 'a', ['c', 'b']);
        expect(meta(twice.lines[0]).dependsOn).toBe('b,c');
        expect(addDependencies(twice.lines, 'a', ['c']).changed).toBe(false);
    });

    it('refuses an unknown target or the task itself', () => {
        expect(() => addDependencies(lines, 'a', ['zz'])).toThrow(/no task with @id:zz/);
        expect(() => addDependencies(lines, 'a', ['a'])).toThrow(/itself/);
    });

    it('refuses a dependency that closes a loop, and names it', () => {
        const ab = addDependencies(lines, 'a', ['b']).lines;
        const bc = addDependencies(ab, 'b', ['c']).lines;
        expect(() => addDependencies(bc, 'c', ['a'])).toThrow(
            "c can't depend on a: that closes a loop, c → a → b → c",
        );
    });

    it('refuses depending on a sub-task, which inherits the wait', () => {
        const nested = ['- [ ] phase <!-- @id:p -->', '  - [ ] step <!-- @id:s -->'];
        expect(() => addDependencies(nested, 'p', ['s'])).toThrow(
            "p can't depend on s: that closes a loop, p → s, which is inside p",
        );
        expect(meta(addDependencies(nested, 's', ['p']).lines[1]).dependsOn).toBe('p');
    });

    it('removes dependencies, dropping the key with the last', () => {
        const both = addDependencies(lines, 'a', ['b', 'c']).lines;
        expect(meta(removeDependencies(both, 'a', ['b']).lines[0]).dependsOn).toBe('c');
        expect(meta(removeDependencies(both, 'a', ['b', 'c']).lines[0]).dependsOn).toBeUndefined();
        expect(removeDependencies(both, 'a', ['zz']).changed).toBe(false);
    });

    it('appends a [[link]] before the metadata, once', () => {
        const linked = linkTask(lines, 'a', 'plans/x.md').lines;
        expect(linked[0]).toBe('- [ ] a [[plans/x.md]] <!-- @id:a -->');
        expect(linkTask(linked, 'a', 'plans/x.md').changed).toBe(false);
        expect(() => linkTask(lines, 'a', 'bad]]path')).toThrow(/not a linkable path/);
    });
});

describe('rewordTask', () => {
    it('replaces the text, keeping indent, bullet, marker and every metadata entry', () => {
        const lines = [
            '- [ ] p <!-- @id:p -->',
            '\t* [/] old words #tag <!-- @id:c @created:x @session:s @dependsOn:p -->',
        ];
        const res = rewordTask(lines, 'c', '  new   words ');
        expect(res.changed).toBe(true);
        expect(res.lines).toEqual([
            '- [ ] p <!-- @id:p -->',
            '\t* [/] new words <!-- @id:c @created:x @session:s @dependsOn:p -->',
        ]);
    });

    it('gives an empty task its text', () => {
        expect(rewordTask(['- [ ]  <!-- @id:e -->'], 'e', 'now some').lines).toEqual([
            '- [ ] now some <!-- @id:e -->',
        ]);
    });

    it('keeps a [[link]] the new text drops, after the text as linkTask writes it, once', () => {
        const plan = ['- [/] the plan [[plans/a.md]] and [[plans/b.md]] <!-- @id:r -->'];
        expect(rewordTask(plan, 'r', 'the new plan').lines[0]).toBe(
            '- [/] the new plan [[plans/a.md]] [[plans/b.md]] <!-- @id:r -->',
        );
        expect(rewordTask(plan, 'r', 'see [[plans/b.md]] first').lines[0]).toBe(
            '- [/] see [[plans/b.md]] first [[plans/a.md]] <!-- @id:r -->',
        );
    });

    it('changes nothing when the text is the same, or the same but for its kept links', () => {
        const lines = ['- [ ] the plan [[plans/x.md]] <!-- @id:r -->'];
        for (const text of ['the plan [[plans/x.md]]', 'the plan']) {
            const res = rewordTask(lines, 'r', text);
            expect(res.changed).toBe(false);
            expect(res.lines).toEqual(lines);
        }
    });

    it('refuses an unknown id, no text, a newline and an opening comment', () => {
        const lines = ['- [ ] a <!-- @id:a -->'];
        expect(() => rewordTask(lines, 'nope', 'x')).toThrow(/no task with @id:nope/);
        expect(() => rewordTask(lines, 'a', ' \t ')).toThrow(/needs some text/);
        expect(() => rewordTask(lines, 'a', 'two\nlines')).toThrow(/cannot hold a newline/);
        expect(() => rewordTask(lines, 'a', 'x <!-- @id:b')).toThrow(/cannot hold "<!--"/);
    });

    it("refuses a line whose text it can't cut out cleanly", () => {
        for (const line of ['- [ ]glued <!-- @id:a -->', '- [ ] a <!-- @id:a --> tail']) {
            expect(() => rewordTask([line], 'a', 'x')).toThrow(/change its text in an editor/);
        }
    });
});

describe('handOverSession', () => {
    it('moves only the open tasks of one session to another', () => {
        const { lines, count } = handOverSession(
            [
                '- [/] working <!-- @id:a @session:old -->',
                '  - [ ] queued <!-- @id:b @session:old -->',
                '  - [x] finished <!-- @id:c @session:old -->',
                '- [ ] not ours <!-- @id:d @session:other -->',
            ],
            'old',
            'new',
        );
        expect(count).toBe(2);
        expect(lines.map((l) => meta(l).session)).toEqual(['new', 'new', 'old', 'other']);
    });
});
