import { describe, expect, it } from 'vitest';
import type { Marker } from './markers';
import { buildTaskTree, type TaskTree, withOutside } from './task-tree';
import { OPEN_STATES } from './tui-states';
import {
    crumbParts,
    dependencyLines,
    fitCrumbs,
    indentFor,
    layerLines,
    markLasts,
    revealOptions,
    sessionLines,
    shortTitle,
    type TaskLine,
    type TuiLine,
    treeLines,
    truncate,
} from './tui-view-model';

const f = (t: string) => `@focused:2026-10-19T${t}:00+00:00`;
const fixture = (): TaskTree =>
    buildTaskTree([
        `- [/] plan <!-- @id:p @session:s ${f('09:00')} -->`,
        '  - [x] phase 0 <!-- @id:p0 @session:s -->',
        `  - [/] phase 1 <!-- @id:p1 @session:s ${f('10:00')} -->`,
        `    - [/] sidetrack <!-- @id:sd @session:s ${f('11:00')} -->`,
        '      - [ ] its follow-up <!-- @id:fu @session:s -->',
        '  - [ ] phase 2 <!-- @id:p2 @session:s -->',
        '- [ ] somebody else <!-- @id:o @session:other -->',
    ]);

/** One string per line: headings in [brackets], crumbs as ids joined by ›, tasks as depth + id. */
const show = (lines: TuiLine[]) =>
    lines.map((l) => {
        if (l.kind === 'heading') return `[${l.text}]`;
        if (l.kind === 'crumbs') return l.path.map((n) => n.id).join(' › ');
        return `${l.depth}${l.chained ? '↳' : ' '}${l.node.id}${l.focus ? ' ◀' : ''}${l.note ? ` (${l.note})` : ''}`;
    });

describe('sessionLines', () => {
    it("shows the focus's ancestors as crumbs, its subtree, then the session's other open tasks", () => {
        expect(show(sessionLines(fixture(), 's'))).toEqual([
            'p › p1',
            '0 sd ◀',
            '0↳fu',
            '[also open]',
            '0 p2 (in plan)',
        ]);
    });

    it("lists the tasks handed to agents under their own heading with the agent's name, not in the subtree", () => {
        const t = buildTaskTree([
            `- [/] plan <!-- @id:p @session:s ${f('09:00')} -->`,
            '  - [/] probe <!-- @id:a1 @session:s @agent:alpha -->',
            '    - [ ] found on the way <!-- @id:fw @session:s -->',
            '  - [ ] next <!-- @id:n @session:s -->',
            '- [/] elsewhere <!-- @id:a2 @session:s @agent:beta -->',
            '- [ ] queued <!-- @id:q @session:s -->',
        ]);
        expect(show(sessionLines(t, 's'))).toEqual([
            '0 p ◀',
            '0↳n',
            '[agents]',
            '0 a1 (alpha · in plan)',
            '0 a2 (beta)',
            '[also open]',
            '0 fw (in probe)',
            '0 q',
        ]);
    });

    it('says so when the session has no focus or there is no session', () => {
        const t = buildTaskTree(['- [ ] queued <!-- @id:q @session:s -->']);
        expect(show(sessionLines(t, 's'))).toEqual([
            '[no focus — `tsk focus <id>` or `tsk push <text>`]',
            '[also open]',
            '0 q',
        ]);
        expect(sessionLines(t, undefined)[0]).toMatchObject({ kind: 'heading' });
    });
});

describe('treeLines', () => {
    it('lays out the whole file compacted', () => {
        expect(show(treeLines(fixture()))).toEqual([
            '0 p',
            '1 p0',
            '1 p1',
            '1↳sd',
            '1↳fu',
            '1 p2',
            '0 o',
        ]);
    });

    it('zooms into a task, with its ancestors as crumbs', () => {
        expect(show(treeLines(fixture(), { hoist: 'sd' }))).toEqual(['p › p1', '0 sd', '0↳fu']);
    });

    it('filters to open tasks and to one session, keeping the ancestors that lead to them', () => {
        expect(show(treeLines(fixture(), { states: OPEN_STATES }))).toEqual([
            '0 p',
            '1 p1',
            '1↳sd',
            '1↳fu',
            '1 p2',
            '0 o',
        ]);
        expect(show(treeLines(fixture(), { session: 'other' }))).toEqual(['0 o']);
        expect(show(treeLines(fixture(), { session: 'nobody' }))).toEqual(['[(no tasks)]']);
    });

    /** Each folded line's hidden-task count, by id. */
    const foldedOf = (lines: TuiLine[]) =>
        Object.fromEntries(
            lines.flatMap((l) =>
                l.kind === 'task' && l.folded !== undefined ? [[l.node.id, l.folded]] : [],
            ),
        );

    it('folds a task: its subtree out of view, and on its line how many tasks that is', () => {
        const lines = treeLines(fixture(), { folded: new Set(['p1']) });
        expect(show(lines)).toEqual(['0 p', '1 p0', '1 p1', '1 p2', '0 o']);
        expect(foldedOf(lines)).toEqual({ p1: 2 });
    });

    it('counts what the filter would show, and marks no fold on a task with nothing under it', () => {
        const lines = treeLines(fixture(), { states: OPEN_STATES, folded: new Set(['p', 'o']) });
        expect(show(lines)).toEqual(['0 p', '0 o']);
        expect(foldedOf(lines)).toEqual({ p: 4 });
    });

    it('opens a folded task it is zoomed into', () => {
        const zoomed = treeLines(fixture(), { hoist: 'p1', folded: new Set(['p1']) });
        expect(show(zoomed)).toEqual(['p', '0 p1', '0↳sd', '0↳fu']);
        expect(foldedOf(zoomed)).toEqual({});
    });

    /** A filter on ids, and each line's id with `~` for one shown only as context. */
    const matching =
        (...ids: string[]) =>
        (n: { id?: string }) =>
            ids.includes(n.id ?? '');
    const marked = (lines: TuiLine[]) =>
        lines.flatMap((l) => (l.kind === 'task' ? [`${l.context ? '~' : ''}${l.node.id}`] : []));

    it('filters to the tasks that match and the ancestors that lead to them, marked as context', () => {
        const lines = treeLines(fixture(), { match: matching('fu', 'p2') });
        expect(marked(lines)).toEqual(['~p', '~p1', '~sd', 'fu', 'p2']);
    });

    it('shows only the states picked, the tasks above them dimmed as context, and counts folds within them', () => {
        const done = new Set<Marker>(['completed']);
        expect(marked(treeLines(fixture(), { states: done }))).toEqual(['~p', 'p0']);
        const todo = new Set<Marker>(['todo']);
        expect(marked(treeLines(fixture(), { states: todo }))).toEqual([
            '~p',
            '~p1',
            '~sd',
            'fu',
            'p2',
            'o',
        ]);
        expect(foldedOf(treeLines(fixture(), { states: todo, folded: new Set(['p1']) }))).toEqual({
            p1: 2,
        });
    });

    it('shows the matches inside folds, setting the folds aside', () => {
        const lines = treeLines(fixture(), { match: matching('fu'), folded: new Set(['p', 'p1']) });
        expect(marked(lines)).toEqual(['~p', '~p1', '~sd', 'fu']);
        expect(foldedOf(lines)).toEqual({});
    });

    it('narrows within a zoom and the open-only filter, and says when nothing matches', () => {
        expect(marked(treeLines(fixture(), { hoist: 'p1', match: matching('fu', 'p2') }))).toEqual([
            '~p1',
            '~sd',
            'fu',
        ]);
        // p0 is done: showing only open states leaves it out even though it matches.
        expect(
            marked(treeLines(fixture(), { states: OPEN_STATES, match: matching('p0', 'p2') })),
        ).toEqual(['~p', 'p2']);
        expect(show(treeLines(fixture(), { hoist: 'p1', match: matching('o') }))).toEqual([
            'p',
            '[no task matches]',
        ]);
    });

    it('marks the focus', () => {
        const t = fixture();
        expect(show(treeLines(t, { focus: t.byId.get('p1') }))).toContain('1 p1 ◀');
    });

    it('says which tasks end their level, for the tree lines', () => {
        const ends = treeLines(fixture()).map((l) =>
            l.kind === 'task'
                ? `${l.node.id}:${(l.lasts ?? []).map((x) => (x ? 'L' : '-')).join('')}`
                : '',
        );
        expect(ends).toEqual(['p:', 'p0:-', 'p1:-', 'sd:-', 'fu:-', 'p2:L', 'o:']);
    });
});

describe('revealOptions', () => {
    const t = fixture();
    const node = (id: string) => {
        const n = t.byId.get(id);
        if (!n) throw new Error(id);
        return n;
    };
    const matching = (id: string) => (n: { id?: string }) => n.id === id;
    const shows = (id: string, o: Parameters<typeof treeLines>[1]) =>
        treeLines(t, o).some((l) => l.kind === 'task' && l.node.id === id);

    it('leaves options that already show the task as they are', () => {
        const folded = new Set(['p2']);
        const match = matching('fu');
        expect(revealOptions(t, node('fu'), { hoist: 'p1', folded, match })).toEqual({
            hoist: 'p1',
            folded: new Set(['p2']),
            match,
        });
    });

    it('drops a zoom the task is not under, and opens only the folds above it', () => {
        const shown = revealOptions(t, node('fu'), {
            hoist: 'o',
            folded: new Set(['p', 'sd', 'p2']),
        });
        expect(shown.hoist).toBeUndefined();
        expect(shown.folded).toEqual(new Set(['p2']));
        expect(shows('fu', shown)).toBe(true);
    });

    it('sets the filter aside when it leaves the task out, then the states shown', () => {
        const match = matching('p2');
        const filtered = revealOptions(t, node('fu'), { match, states: OPEN_STATES });
        expect(filtered.match).toBeUndefined();
        expect(filtered.states).toBe(OPEN_STATES);
        // p0 is done.
        const done = revealOptions(t, node('p0'), { match, states: OPEN_STATES });
        expect(done.match).toBeUndefined();
        expect(done.states).toBeUndefined();
        expect(shows('p0', done)).toBe(true);
    });
});

describe('markLasts', () => {
    it("reads each level's end off the lines, and a heading ends every level", () => {
        const t = buildTaskTree(['- [ ] a <!-- @id:a -->', '- [ ] b <!-- @id:b -->']);
        const task = (id: string, depth: number): TuiLine => {
            const node = t.byId.get(id);
            if (!node) throw new Error(id);
            return { kind: 'task', node, depth, chained: false, focus: false, waits: 0, needed: 0 };
        };
        const lines = markLasts([
            task('a', 0),
            task('b', 1),
            task('b', 2),
            task('b', 1),
            { kind: 'heading', text: 'also open' },
            task('a', 1),
        ]);
        expect(lines.map((l) => (l.kind === 'task' ? l.lasts : undefined))).toEqual([
            [],
            [false],
            [false, true],
            [true],
            undefined,
            [true],
        ]);
    });
});

/** Phase b waits on a and on c; c waits on a; d waits on b; e sits under b; z is a loose task. */
const deps = (): TaskTree =>
    buildTaskTree([
        '- [x] a <!-- @id:a -->',
        '- [ ] b <!-- @id:b @dependsOn:a,c,gone -->',
        '  - [ ] e <!-- @id:e -->',
        '- [/] c <!-- @id:c @dependsOn:a -->',
        '- [ ] d <!-- @id:d @dependsOn:b -->',
        '- [ ] z <!-- @id:z -->',
    ]);
const badges = (lines: TuiLine[]) =>
    Object.fromEntries(
        lines
            .filter((l): l is TaskLine => l.kind === 'task')
            .map((l) => [l.node.id, `${l.waits}/${l.needed}`]),
    );

describe('dependency badges', () => {
    it('count the own dependencies still holding a task back, and the open tasks waiting on it', () => {
        expect(badges(treeLines(deps()))).toEqual({
            a: '0/0', // b and c name it, but it's done: nobody waits
            b: '2/1', // c is open, gone isn't in the file; d waits on it
            e: '0/0', // waits through b, which already shows it
            c: '0/1',
            d: '1/0',
            z: '0/0',
        });
    });
});

describe('dependencyLines', () => {
    it('shows what the task needs, followed back, then the task, then what needs it, marking the focus', () => {
        const t = deps();
        expect(show(dependencyLines(t, 'd', t.byId.get('a')))).toEqual([
            '[needs]',
            '0 b',
            '1 a ◀',
            '1 c',
            '0 d',
            '[nothing needs it]',
        ]);
    });

    it('names a dependency the file lacks, and lists each task once', () => {
        expect(show(dependencyLines(deps(), 'b'))).toEqual([
            '[needs]',
            '0 a',
            '0 c', // c needs a too, but a is already shown
            '[not in any file: gone]',
            '0 b',
            '[needed by]',
            '0 d',
        ]);
    });

    it('includes what a task above still waits on, saying through which', () => {
        expect(show(dependencyLines(deps(), 'e'))).toEqual([
            'b',
            '[needs]',
            '0 c (through b)',
            '0↳a',
            '0 e',
            '[nothing needs it]',
        ]);
    });

    it('says so for an unknown id', () => {
        expect(show(dependencyLines(deps(), 'nope'))).toEqual(['[no task @id:nope]']);
    });
});

describe('layerLines', () => {
    it('lists the open tasks in a dependency, step by step', () => {
        const t = deps();
        expect(show(layerLines(t, t.byId.get('c')))).toEqual([
            '[step 1 · can start now]',
            '0 c ◀',
            '[step 2]',
            '0 b',
            '[step 3]',
            '0 d',
        ]);
    });

    it('lists a task in a file beside it that one here waits on, with its file, and finds its own dependencies', () => {
        const backlog = buildTaskTree(['- [ ] theirs <!-- @id:x -->']);
        const own = buildTaskTree(['- [ ] ours <!-- @id:a @dependsOn:x -->']);
        const t = withOutside(own, [{ file: '/w/stack.tsk', tree: backlog }]);
        expect(show(layerLines(t))).toEqual([
            '[step 1 · can start now]',
            '0 x (stack.tsk)',
            '[step 2]',
            '0 a',
        ]);
        expect(show(dependencyLines(t, 'x'))).toEqual([
            '[needs nothing]',
            '0 x (stack.tsk)',
            '[needed by]',
            '0 a',
        ]);
    });

    it('sets a loop apart, and says when there are no dependencies', () => {
        const loop = buildTaskTree([
            '- [ ] a <!-- @id:a @dependsOn:b -->',
            '- [ ] b <!-- @id:b @dependsOn:a -->',
        ]);
        expect(show(layerLines(loop))).toEqual(['[in a loop — or waiting on one]', '0 a', '0 b']);
        expect(layerLines(fixture())[0]).toMatchObject({ kind: 'heading' });
    });
});

describe('shortTitle', () => {
    it('drops tags and links, and stops at the first " — " or ": "', () => {
        expect(shortTitle('#p/tsk tsk for Claude — a CLI and a TUI [[plans/x.md]]')).toBe(
            'tsk for Claude',
        );
        expect(shortTitle('Phase 5 — VS Code: tsk:<id> links')).toBe('Phase 5');
        expect(shortTitle('look: theme colours')).toBe('look');
    });
    it('keeps a text with no separator whole', () => {
        expect(shortTitle('palette entry (tools/palette)')).toBe('palette entry (tools/palette)');
    });
});

describe('fitCrumbs', () => {
    const labels = ['tsk for Claude', 'Phase 3 — TUI', 'the view model', 'a detour'];

    it('keeps everything when it fits', () => {
        expect(fitCrumbs(labels, 200)).toBe(
            'tsk for Claude › Phase 3 — TUI › the view model › a detour',
        );
    });

    it('drops labels from the middle first, keeping the first and the last', () => {
        expect(fitCrumbs(labels, 46)).toBe('tsk for Claude › … › the view model › a detour');
        expect(fitCrumbs(labels, 30)).toBe('tsk for Claude › … › a detour');
    });

    it('falls back to the last label, truncated', () => {
        expect(fitCrumbs(labels, 12)).toBe('… › a detour');
        expect(fitCrumbs(labels, 8)).toBe('… › a d…');
        expect(fitCrumbs([], 10)).toBe('');
    });
});

describe('crumbParts', () => {
    const labels = ['tsk for Claude', 'Phase 3 — TUI', 'the view model', 'a detour'];

    it("keeps each label's index, so a click finds it, and none on the separators or …", () => {
        expect(crumbParts(labels, 30)).toEqual([
            { text: 'tsk for Claude', index: 0 },
            { text: ' › ' },
            { text: '…' },
            { text: ' › ' },
            { text: 'a detour', index: 3 },
        ]);
    });
    it('cuts the last label it keeps, still pointing at it', () => {
        expect(crumbParts(labels, 8)).toEqual([
            { text: '…' },
            { text: ' › ' },
            { text: 'a d…', index: 3 },
        ]);
    });
});

describe('indentFor and truncate', () => {
    it('indents two columns a level up to a third of the width, then shows the depth', () => {
        expect(indentFor(2, 40)).toEqual({ columns: 4 });
        expect(indentFor(6, 40)).toEqual({ columns: 12 });
        expect(indentFor(7, 40)).toEqual({ columns: 12, badge: '↳7' });
        expect(indentFor(3, 4)).toEqual({ columns: 2, badge: '↳3' });
    });

    it('truncates with an ellipsis', () => {
        expect(truncate('abcdef', 4)).toBe('abc…');
        expect(truncate('abc', 4)).toBe('abc');
        expect(truncate('abc', 1)).toBe('a');
    });
});
