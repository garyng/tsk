import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type OpResult, type OpsDeps, toggleFinished } from '../lib/task-ops';
import { buildTaskTree, withOutside } from '../lib/task-tree';
import { type Delivery, messageText } from '../lib/tui-ask';
import type { SelectReply } from '../lib/tui-channel';
import { lineHeight } from '../lib/tui-layout';
import { sessionLines, type TaskLine } from '../lib/tui-view-model';
import { App, DOUBLE_CLICK_MS, MESSAGE_MS, type TuiIo, type Who } from './app';

/** Where the App last put the terminal's cursor: Ink's `useCursor`, recorded. */
const cursor = vi.hoisted(() => ({ at: undefined as { x: number; y: number } | undefined }));
vi.mock('ink', async (importOriginal) => {
    const ink = await importOriginal<typeof import('ink')>();
    return {
        ...ink,
        useCursor: () => ({
            setCursorPosition: (at: { x: number; y: number } | undefined) => {
                cursor.at = at;
            },
        }),
    };
});

const fixture = [
    '- [/] the plan <!-- @id:p @session:s @focused:2026-10-19T09:00:00+00:00 -->',
    '  - [/] phase one <!-- @id:p1 @session:s @focused:2026-10-19T10:00:00+00:00 -->',
    '    - [ ] step a <!-- @id:a @session:s -->',
    '    - [ ] step b <!-- @id:b @session:s -->',
    '  - [ ] phase two <!-- @id:p2 @session:s -->',
];

function fakeDeps(): OpsDeps {
    let t = Date.parse('2026-10-19T11:00:00Z');
    return {
        generateId: () => 'newid001',
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

/** An in-memory file: `change` edits it, as a session's `tsk` would, and fires the watch. */
function fakeIo(who: Who = { session: 's' }, start: readonly string[] = fixture) {
    let lines = [...start];
    let onChange = () => {};
    let current = who;
    const deps = fakeDeps();
    const io: TuiIo = {
        fileName: 'claude.tsk',
        load: () => buildTaskTree(lines),
        watch: (cb) => {
            onChange = cb;
            return () => {};
        },
        who: () => current,
        pollMs: 20,
        open: async () => undefined,
        // The list alone: the pane's own tests turn it on.
        detail: false,
    };
    return {
        io,
        text: () => lines.join('\n'),
        setWho: (w: Who) => {
            current = w;
        },
        change: (op: (lines: readonly string[], deps: OpsDeps) => OpResult) => {
            const res = op(lines, deps);
            if (res.changed) {
                lines = res.lines;
                onChange();
            }
        },
    };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/** Wait until `check` holds, up to `ms` — for a frame that waits on an async change under load; fails when it never does. */
async function until(check: () => boolean, ms = 2000) {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for: ${check}`);
        await tick(10);
    }
}
let ui: ReturnType<typeof render> | undefined;
afterEach(() => ui?.unmount());

/** The footer bar: the keys that apply, or a message; the followed session on the right. */
const footer = () => ui?.lastFrame()?.split('\n').filter(Boolean).at(-1)?.trim() ?? '';
/** Which task is selected, as the tab strip's position (`2/4`). */
const position = () => /(\d+\/\d+) *$/.exec(ui?.lastFrame()?.split('\n')[0] ?? '')?.[1];

describe('tsk TUI', () => {
    it("opens on the session view with the focus selected, showing its subtree and the session's other open tasks", () => {
        ui = render(<App io={fakeIo().io} />);
        const frame = ui.lastFrame() ?? '';
        expect(frame).toMatch(/^ tsk {2}Session {2}Tree {2}Steps +claude\.tsk {2}1\/4 ?$/m);
        expect(frame).toContain('the plan'); // the crumbs above the focus
        expect(frame).toMatch(/^◆◐ phase one\n │ ○ step a\n └ ○ step b\n/m);
        expect(frame).toContain('also open');
        expect(footer()).toMatch(/^d deps {2}⏎ zoom {2}e open {2}\? keys +s$/);
    });

    it('lists the tasks handed to agents under their own heading, each with its agent', () => {
        const start = [...fixture, '- [/] probe the hooks <!-- @id:h @session:s @agent:alpha -->'];
        ui = render(<App io={fakeIo({ session: 's' }, start).io} />);
        expect(ui.lastFrame()).toMatch(
            /^── agents ─+\n ◐ probe the hooks {2}alpha\n── also open ─+\n ○ phase two {2}in the plan$/m,
        );
    });

    it('moves on every character of a batched read', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('jj');
        await tick();
        expect(position()).toBe('3/4');
    });

    it('switches to the tree view on tab, and zooms in and out', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('\t');
        await tick();
        expect(ui.lastFrame()).toContain(' └ ○ phase two');
        ui.stdin.write('g\r');
        await tick();
        expect(ui.lastFrame()).toContain('Steps  · zoomed');
        ui.stdin.write('u');
        await tick();
        expect(ui.lastFrame()).not.toContain('zoomed');
    });

    it('stays on the selected task when a change from outside moves the focus away from it', async () => {
        const f = fakeIo();
        ui = render(<App io={f.io} />);
        ui.stdin.write('j');
        await tick();
        ui.stdin.write('k'); // phase one, chosen, not just the focus it opened on
        await tick();
        // Phase one done by the session: its focus falls back to the plan.
        f.change((l, deps) => toggleFinished(l, 'p1', 'completed', deps));
        await tick();
        expect(ui.lastFrame()).toMatch(/^◆◐ the plan/m);
        expect(position()).toBe('2/5'); // still phase one, now under the plan
    });

    it('changes nothing in the file on the keys that used to: s, S, c and x', async () => {
        const f = fakeIo();
        ui = render(<App io={f.io} />);
        const before = f.text();
        ui.stdin.write('j'); // step a
        await tick();
        ui.stdin.write('sScx');
        await tick();
        expect(f.text()).toBe(before);
        expect(position()).toBe('2/4');
        expect(footer()).toMatch(/^d deps /);
    });

    it('follows the session it is told to show', async () => {
        const f = fakeIo({ session: 'nobody' });
        ui = render(<App io={f.io} />);
        expect(ui.lastFrame()).toContain('no focus');
        f.setWho({ session: 's', note: 'idle' });
        await tick(60);
        expect(footer()).toMatch(/ s · idle$/);
        expect(ui.lastFrame()).toContain('phase one');
    });

    it('keeps the session in a narrow pane, dropping key hints to make room', async () => {
        const io: TuiIo = {
            ...fakeIo(
                { session: '250bd3cc', note: 'busy' },
                fixture.map((l) => l.replace('@session:s', '@session:250bd3cc')),
            ).io,
            tell: async () => () => {},
        };
        ui = render(<App io={io} />);
        // A quarter of a wide window, as `tsk tmux-pane` opens it.
        Object.defineProperty(ui.stdout, 'columns', { value: 64 });
        ui.stdout.emit('resize');
        await tick();
        expect(footer()).toMatch(/ 250bd3cc · busy$/);
        expect(footer()).toMatch(/\? keys/);
    });

    it("badges what waits, opens a task's dependencies on d, goes back on u, and steps on tab", async () => {
        const withDeps = fixture.map((l) =>
            l.includes('@id:b ') ? l.replace('@id:b ', '@id:b @dependsOn:a ') : l,
        );
        ui = render(<App io={fakeIo({ session: 's' }, withDeps).io} />);
        let frame = ui.lastFrame() ?? '';
        expect(frame).toContain('○ step a  ▶1');
        expect(frame).toContain('○ step b  ◀1');
        ui.stdin.write('jj'); // step b
        await tick();
        ui.stdin.write('d');
        await tick();
        frame = ui.lastFrame() ?? '';
        expect(frame).toContain('deps of step b');
        expect(frame).toMatch(
            /── needs ─+\n ○ step a {2}▶1\n ○ step b {2}◀1\n── nothing needs it ─+\n/,
        );
        expect(position()).toBe('2/2');
        ui.stdin.write('u');
        await tick();
        expect(ui.lastFrame()).not.toContain('deps of');
        ui.stdin.write('\t\t');
        await tick();
        frame = ui.lastFrame() ?? '';
        expect(frame).toMatch(
            /── step 1 · can start now ─+\n ○ step a {2}▶1 {2}in phase one\n── step 2 ─+\n/,
        );
    });

    it('wraps a long task under its own text, in as many lines as the layout counts', () => {
        const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
        const start = [...fixture.slice(0, 2), `    - [ ] ${long} <!-- @id:long @session:s -->`];
        ui = render(<App io={fakeIo({ session: 's' }, start).io} />);
        const rows = (ui.lastFrame() ?? '').split('\n');
        const first = rows.findIndex((r) => r.includes('word0 '));
        const column = rows[first]?.indexOf('word0') ?? -1;
        const line = sessionLines(buildTaskTree(start), 's').find(
            (l): l is TaskLine => l.kind === 'task' && l.node.id === 'long',
        );
        if (!line) throw new Error('no line');
        const height = lineHeight(line, 100); // ink-testing-library's width
        expect(height).toBeGreaterThan(2);
        const wrapped = rows.slice(first, first + height);
        for (const r of wrapped.slice(1)) expect(r.slice(0, column).trim()).toBe('');
        expect(wrapped.map((r) => r.slice(column).trim()).join(' ')).toBe(long);
        expect(rows[first + height]).not.toMatch(/word/);
    });

    it('folds the selected task on space in the tree view, and unfolds it on space again', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('2'); // the tree view, on the focus: phase one
        await tick();
        ui.stdin.write(' ');
        await tick();
        expect(ui.lastFrame()).toMatch(/│▸◐ phase one {2}\+2\n/);
        // The text in line with its sibling's.
        const rows = (ui.lastFrame() ?? '').split('\n');
        const at = (text: string) => rows.find((r) => r.includes(text))?.indexOf(text);
        expect(at('phase one')).toBe(at('phase two'));
        expect(ui.lastFrame()).not.toContain('step a');
        expect(footer()).toContain('space unfold');
        ui.stdin.write(' ');
        await tick();
        expect(ui.lastFrame()).toContain('step a');
        expect(ui.lastFrame()).not.toContain('▸');
        expect(footer()).toContain('space fold');
    });

    it('folds the parent on space on a task with nothing under it, and selects the parent', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('2j'); // step a
        await tick();
        expect(position()).toBe('3/5');
        ui.stdin.write(' ');
        await tick();
        expect(ui.lastFrame()).not.toContain('step a');
        expect(position()).toBe('2/3');
        expect(footer()).toContain('space unfold');
    });

    it('folds everything on z and unfolds everything on Z, the selection on its ancestor meanwhile', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('2j'); // step a
        await tick();
        ui.stdin.write('z');
        await tick();
        expect(ui.lastFrame()).toMatch(/◐ the plan {2}\+4\n/);
        expect(position()).toBe('1/1');
        ui.stdin.write('Z');
        await tick();
        expect(ui.lastFrame()).toContain('step a');
        expect(position()).toBe('3/5'); // back on step a: nothing moved the selection off it
    });

    it('keeps the folds while another view is shown, and folds only in the tree view', async () => {
        ui = render(<App io={fakeIo().io} />);
        for (const key of ['2', ' ', '1']) {
            // Apart: a read's keys act on one render, so a fold right after `2` would still see the session view.
            ui.stdin.write(key);
            await tick();
        }
        expect(ui.lastFrame()).toContain('step a');
        ui.stdin.write(' ');
        await tick();
        expect(footer()).toContain('folding works in the tree view');
        ui.stdin.write('2');
        await tick();
        expect(ui.lastFrame()).not.toContain('step a');
    });

    /** The tab strip: tabs, flags, file and position. */
    const strip = () => ui?.lastFrame()?.split('\n')[0] ?? '';
    /** Open the filter's prompt and type `query` into it, then wait for the tally. */
    const typeFilter = async (query: string, tally: RegExp) => {
        ui?.stdin.write('/');
        await until(() => footer().startsWith('/'));
        ui?.stdin.write(query);
        await until(() => tally.test(footer()));
    };

    it('narrows the tree as a query is typed after /, from any view, selecting the first match', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('/');
        await until(() => footer().startsWith('/'));
        expect(footer()).toMatch(/^\/ +↑↓ move · ⏎ keep · esc clear$/);
        ui.stdin.write('step b');
        await until(() => footer().includes('1 match'));
        expect(footer()).toMatch(/^\/ step b +1 match · ↑↓ move · ⏎ keep · esc clear$/);
        const frame = ui.lastFrame() ?? '';
        for (const shown of ['the plan', 'phase one', 'step b']) expect(frame).toContain(shown);
        for (const gone of ['step a', 'phase two']) expect(frame).not.toContain(gone);
        expect(position()).toBe('3/3');
        expect(cursor.at).toEqual({ x: ' / step b'.length, y: 23 });
    });

    it('keeps the filter on Enter, among the flags, and Esc clears it, the selection staying put', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('2');
        await tick();
        await typeFilter('step b', /1 match/);
        ui.stdin.write('\r');
        await until(() => strip().includes('/step b'));
        expect(strip()).toMatch(/Steps {2}· \/step b +claude\.tsk {2}3\/3 ?$/);
        expect(footer()).toMatch(/^esc clear /);
        ui.stdin.write('j'); // the keys are the tree's again
        await tick();
        ui.stdin.write('\x1b');
        await until(() => !strip().includes('/step b'));
        expect(ui.lastFrame()).toContain('step a');
        expect(position()).toBe('4/5'); // still step b
    });

    it('clears the filter on Esc in the prompt, the selection back where it was', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('2');
        await tick();
        expect(position()).toBe('2/5'); // phase one, the focus
        await typeFilter('step b', /1 match/);
        ui.stdin.write('\x1b');
        await until(() => !footer().startsWith('/'));
        expect(ui.lastFrame()).toContain('step a');
        expect(position()).toBe('2/5');
        expect(strip()).not.toContain('· /');
    });

    it('moves the selection on up and down while the query is typed, and to the first match on the next key', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('2');
        await tick();
        await typeFilter('step', /2 matches/);
        expect(position()).toBe('3/4'); // step a
        ui.stdin.write('\x1b[B');
        await until(() => position() === '4/4');
        ui.stdin.write('\x1b[A');
        await until(() => position() === '3/4');
        ui.stdin.write('\x1b[A');
        await until(() => position() === '2/4'); // phase one, shown as what they sit in
        expect(footer()).toMatch(/^\/ step /); // still typing
        ui.stdin.write(' ');
        await until(() => position() === '3/4');
        ui.stdin.write('\x1b[B\r');
        await until(() => strip().includes('/step'));
        expect(position()).toBe('4/4'); // Enter keeps where it moved to
    });

    it('edits the kept filter on / again', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('2');
        await tick();
        await typeFilter('step', /2 matches/);
        ui.stdin.write('\r');
        await until(() => strip().includes('/step'));
        expect(position()).toBe('3/4'); // step a, the first match
        await typeFilter(' b', /1 match/);
        expect(footer()).toMatch(/^\/ step b /);
        ui.stdin.write('\r');
        await until(() => strip().includes('/step b'));
    });

    it('takes a query typed and sent in the same read as the /, as tmux send-keys does', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('2');
        await tick();
        ui.stdin.write('/step b\r');
        await until(() => strip().includes('/step b'));
        expect(position()).toBe('3/3');
    });

    it('finds a task by its @id, and shows the matches inside folds, which wait meanwhile', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('2');
        await tick();
        ui.stdin.write(' '); // fold phase one
        await tick();
        await typeFilter('B', /1 match/); // step b's @id
        expect(ui.lastFrame()).toContain('step b');
        await typeFilter('', /1 match/); // the prompt open again: the kept query back in it
        ui.stdin.write('\x15P2\r'); // ctrl+u, then phase two's @id
        await until(() => strip().includes('/P2'));
        expect(ui.lastFrame()).toContain('phase two  p2'); // matched through its id, which it shows
        expect(ui.lastFrame()).not.toContain('step b');
        ui.stdin.write(' ');
        await until(() => footer().startsWith('no folding'));
        expect(footer()).toBe('no folding while filtered; esc clears the filter');
        ui.stdin.write('\x1b');
        await until(() => !strip().includes('/P2'));
        expect(ui.lastFrame()).not.toContain('step a'); // the fold is back
    });

    it('offers the keys that apply to the selected task, as its state reads them', async () => {
        ui = render(<App io={fakeIo().io} />);
        expect(footer()).toMatch(/^d deps {2}⏎ zoom /);
        ui.stdin.write('\t'); // the tree view: the list of states applies there
        await tick();
        expect(footer()).toContain('a states');
    });

    it('puts the way back first in the dependency view', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('d');
        await tick();
        expect(footer()).toMatch(/^esc back {2}d deps /);
    });

    it('keeps "? keys" when the hints have to shrink', () => {
        ui = render(<App io={fakeIo().io} />);
        expect(footer()).toContain('? keys');
    });

    it('shows a message in place of the hints for a few seconds, then the hints again', async () => {
        // Only the timeouts are fake: React runs effects (which start the clock) on
        // real macrotasks, so let those run before moving the clock on.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const settle = async () => {
            for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
            await vi.advanceTimersByTimeAsync(20);
        };
        try {
            ui = render(<App io={fakeIo().io} />);
            ui.stdin.write('e');
            await settle();
            expect(footer()).toBe('opened p1 in VS Code');
            await vi.advanceTimersByTimeAsync(MESSAGE_MS - 200);
            await settle();
            expect(footer()).toBe('opened p1 in VS Code');
            await vi.advanceTimersByTimeAsync(200);
            await settle();
            expect(footer()).toMatch(/\? keys/);
        } finally {
            vi.useRealTimers();
        }
    });

    it('clears a message at the next key', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('e');
        await until(() => footer() === 'opened p1 in VS Code');
        expect(footer()).toBe('opened p1 in VS Code');
        ui.stdin.write('j');
        await until(() => /\? keys/.test(footer()));
        expect(footer()).toMatch(/\? keys/);
    });

    it('shows every key on ?, grouped under headings', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('?');
        await tick();
        let frame = ui.lastFrame() ?? '';
        expect(frame).toMatch(/── move ─+\nj\/k ↑\/↓ +move\n/);
        expect(frame).toMatch(/── task ─+\nm +message the followed Claude about it /);
        expect(frame).toMatch(/↓ \d+ more · j\/k/); // taller than the 24-row test terminal
        ui.stdin.write('G');
        await tick();
        frame = ui.lastFrame() ?? '';
        expect(frame).toContain('q ctrl+c  quit');
        expect(frame).toContain('background  not reported, dark');
        expect(frame).toMatch(/↑ \d+ more/);
        expect(position()).toBe('1/4'); // the move keys scrolled the overlay, not the list
        ui.stdin.write('\x1b');
        await until(() => !(ui?.lastFrame() ?? '').includes('q ctrl+c  quit'));
        expect(position()).toBe('1/4');
    });

    it('wraps a long help under its own text in a narrow pane', async () => {
        ui = render(<App io={fakeIo().io} />);
        Object.defineProperty(ui.stdout, 'columns', { value: 64 });
        ui.stdout.emit('resize');
        await tick();
        ui.stdin.write('?');
        await tick();
        let frame = ui.lastFrame() ?? '';
        for (let i = 0; i < 80 && !/\n {10}cancels\)/.test(frame); i++) {
            ui.stdin.write('j');
            await tick();
            frame = ui.lastFrame() ?? '';
        }
        expect(frame).toMatch(
            /\nm {9}message the followed Claude about it \(⏎ sends, esc\n {10}cancels\)/,
        );
    });
});

/** A plan long enough to scroll in any terminal: filler, then phase one's own line (65), then more. */
const plan = (phaseOne = 'phase one in detail') =>
    [
        '# The plan',
        '',
        ...Array.from({ length: 60 }, (_, i) => `- filler ${i}`),
        '',
        '## Phase one',
        '',
        `- tsk:p1 ${phaseOne}`,
        ...Array.from({ length: 100 }, (_, i) => `- more ${i}`),
    ].join('\n');

const linked = fixture.map((l, i) =>
    i === 0 ? l.replace('the plan', 'the plan [[plans/x.md]]') : l,
);

/** The fake file, plus a linked plan that can change under the pane, and what `o` opened. */
function detailIo(start: readonly string[] = linked) {
    const f = fakeIo({ session: 's' }, start);
    let text = plan();
    let fire = () => {};
    const opened: [string, number][] = [];
    const io: TuiIo = {
        ...f.io,
        detail: true,
        readLinked: (path) => {
            if (path !== 'plans/x.md') throw new Error('boom');
            return { file: '/repo/plans/x.md', text };
        },
        watchLinked: (_path, cb) => {
            fire = cb;
            return () => {};
        },
        openFile: async (file, line) => {
            opened.push([file, line]);
            return undefined;
        },
    };
    return {
        io,
        opened,
        edit: (next: string) => {
            text = next;
            fire();
        },
    };
}

/** The one-based plan line at the top of the pane, from the rule naming the file. */
const fileLine = () => /x\.md:(\d+)/.exec(ui?.lastFrame() ?? '')?.[1];
/** The side-by-side pane's border column: where its first line, `│━━━`, starts. */
const edge = () => ui?.lastFrame()?.split('\n')[2]?.indexOf('│━');

/** A fake io following a Claude: `tell` records each post and hands back its delivery callback. */
function telling() {
    const f = fakeIo();
    const posts: string[] = [];
    const deliveries: ((d: Delivery) => void)[] = [];
    let stopped = 0;
    let failure: Error | undefined;
    const io: TuiIo = {
        ...f.io,
        tell: async (text, onDelivery) => {
            if (failure) throw failure;
            posts.push(text);
            deliveries.push(onDelivery);
            return () => {
                stopped++;
            };
        },
    };
    return {
        ...f,
        io,
        posts,
        /** The latest post's delivery, as the transcript would report it. */
        deliver: (d: Delivery) => deliveries.at(-1)?.(d),
        stopped: () => stopped,
        fail: (e: Error) => {
            failure = e;
        },
    };
}

describe('tsk TUI, the states the tree shows', () => {
    const start = [...fixture, '- [x] shipped <!-- @id:d @session:s -->'];
    /** The tab strip, the first row. */
    const strip = () => ui?.lastFrame()?.split('\n')[0] ?? '';

    it('a opens the list, h and l move, space ticks, Enter keeps it, and the tab strip says what shows', async () => {
        ui = render(<App io={fakeIo({ session: 's' }, start).io} />);
        ui.stdin.write('a'); // from the session view: the tree, and the list
        await until(() => footer().startsWith('show'));
        expect(strip()).toMatch(/Tree/);
        expect(footer()).toMatch(/^show {2}■ ○ todo {2}■ ◐ in progress {2}■ ✓ done /);
        expect(ui.lastFrame()).toContain('shipped');
        ui.stdin.write('ll');
        await tick();
        ui.stdin.write(' ');
        await until(() => footer().includes('□ ✓ done'));
        expect(ui.lastFrame()).toContain('shipped'); // nothing changes until Enter
        ui.stdin.write('\r');
        await until(() => !(ui?.lastFrame() ?? '').includes('shipped'));
        expect(strip()).toContain('· ○◐✕→•');
        expect(footer()).toContain('a states');
    });

    it('Esc leaves the states as they were, and an empty list is refused', async () => {
        ui = render(<App io={fakeIo({ session: 's' }, start).io} />);
        ui.stdin.write('2');
        await tick();
        ui.stdin.write('a');
        await until(() => footer().startsWith('show'));
        ui.stdin.write(' l l');
        await tick();
        ui.stdin.write('\x1b');
        await until(() => !footer().startsWith('show'));
        expect(ui.lastFrame()).toContain('step a');
        expect(strip()).not.toContain('·');
        ui.stdin.write('a');
        await until(() => footer().startsWith('show'));
        for (const keys of [' ', 'l ', 'l ', 'l ', 'l ', 'l ']) {
            ui.stdin.write(keys);
            await tick();
        }
        expect(footer()).not.toContain('■');
        ui.stdin.write('\r');
        await until(() => footer() === 'tick a state to show');
        expect(footer()).toBe('tick a state to show');
        expect(ui.lastFrame()).toContain('step a');
        ui.stdin.write('l'); // the list is still open, and the key clears the message
        await until(() => footer().startsWith('show'));
        expect(footer()).toMatch(/^show {2}□ ○ todo/);
    });
});

describe('tsk TUI, m messages the session', () => {
    const a = { id: 'a', title: 'step a', file: 'claude.tsk' };
    const p1 = { id: 'p1', title: 'phase one', file: 'claude.tsk' };
    /** `m`, then Enter on the box it opens (typing `typed` first). */
    const send = async (typed: string) => {
        ui?.stdin.write('m');
        await until(() => footer().startsWith('message s'));
        ui?.stdin.write(typed);
        await tick();
        ui?.stdin.write('\r');
    };
    /** `?` twice: clears the message and leaves everything else as it was. */
    const clear = async () => {
        ui?.stdin.write('??');
        await tick();
    };

    it("sends what's typed about the selected task, leaves the file alone, and shows it until it's read", async () => {
        const f = telling();
        ui = render(<App io={f.io} />);
        const before = f.text();
        ui.stdin.write('j'); // step a
        await tick();
        expect(footer()).toMatch(/^m message {2}d deps /);
        await send('mark it done');
        await until(() => footer() === 'sent s the message about a');
        expect(f.posts).toEqual([messageText([a], 'mark it done')]);
        expect(f.text()).toBe(before);
        await clear();
        expect(footer()).toMatch(/^m message .*→ a sent 0:0\d · s$/);
        f.deliver('queued');
        await tick();
        expect(footer()).toMatch(/→ a queued 0:0\d · s$/);
        f.deliver('read');
        await until(() => footer() === 's has read the message about a');
        await clear();
        expect(footer()).not.toContain('→');
    });

    it('v marks tasks, m sends one message about them all, and the marks go once it is sent', async () => {
        const f = telling();
        ui = render(<App io={f.io} />);
        ui.stdin.write('j'); // step a
        await tick();
        expect(footer()).toContain('v mark');
        ui.stdin.write('v');
        await tick();
        expect(footer()).toContain('v unmark');
        ui.stdin.write('jv'); // step b
        await tick();
        expect(ui.lastFrame()).toMatch(/^●│ ○ step a$/m);
        expect(ui.lastFrame()).toMatch(/^●└ ○ step b$/m);
        expect(footer()).toMatch(/^esc unmark all .* ● 2 · s$/);
        ui.stdin.write('k'); // the selection moves; m is still about the marked ones
        await tick();
        ui.stdin.write('m');
        await until(() => footer().startsWith('message s about 2 ›'));
        ui.stdin.write('do both\r');
        await until(() => footer() === 'sent s the message about a, b');
        const b = { id: 'b', title: 'step b', file: 'claude.tsk' };
        expect(f.posts).toEqual([messageText([a, b], 'do both')]);
        expect(ui.lastFrame()).not.toContain('●');
    });

    it('Esc unmarks every task before it does anything else, and v again unmarks one', async () => {
        const f = telling();
        ui = render(<App io={f.io} />);
        ui.stdin.write('jvjv');
        await tick();
        ui.stdin.write('v'); // step b again
        await tick();
        expect(footer()).toMatch(/● 1 · s$/);
        ui.stdin.write('\x1b');
        await tick();
        expect(ui.lastFrame()).not.toContain('●');
        expect(position()).toBe('3/4'); // nothing else moved
    });

    it('sends nothing on Enter with nothing typed', async () => {
        const f = telling();
        ui = render(<App io={f.io} />);
        await send('   ');
        await until(() => footer() === 'not sent');
        expect(f.posts).toEqual([]);
    });

    it("puts a second message in the first one's place, and stops watching for the first", async () => {
        const f = telling();
        ui = render(<App io={f.io} />);
        await send('one');
        await until(() => f.posts.length === 1);
        await tick();
        ui.stdin.write('jj'); // step b
        await tick();
        await send('two');
        await until(() => footer() === 'sent s the message about b');
        expect(f.posts).toEqual([
            messageText([p1], 'one'),
            messageText([{ id: 'b', title: 'step b', file: 'claude.tsk' }], 'two'),
        ]);
        expect(f.stopped()).toBe(1);
        await clear();
        expect(footer()).toMatch(/→ b sent /);
    });

    it('says when the session drops it unread, and when the post fails', async () => {
        const f = telling();
        ui = render(<App io={f.io} />);
        await send('look');
        await until(() => f.posts.length === 1);
        f.deliver('removed');
        await until(() => footer() === 's dropped the message about p1 unread');
        await clear();
        expect(footer()).not.toContain('→');
        f.fail(new Error('connect ECONNREFUSED'));
        await send('again');
        await until(() => footer() === "couldn't message s: connect ECONNREFUSED");
        expect(footer()).toBe("couldn't message s: connect ECONNREFUSED");
    });

    it('edits the message with the line keys before sending it', async () => {
        const f = telling();
        ui = render(<App io={f.io} />);
        const before = f.text();
        ui.stdin.write('m');
        await until(() => footer().startsWith('message s'));
        expect(footer()).toMatch(/^message s › {2,}⏎ send · ⇧⏎ new line · esc cancel$/);
        ui.stdin.write('check the big drag');
        await tick();
        ui.stdin.write('\x17'); // ctrl+w
        await tick();
        ui.stdin.write('edge c'); // the keys are text now: c is a letter
        await tick();
        ui.stdin.write('\x1b\x7f'); // alt+backspace
        await tick();
        expect(footer()).toMatch(/^message s › check the big edge {2,}⏎ send/);
        expect(f.posts).toEqual([]);
        expect(f.text()).toBe(before);
        ui.stdin.write('\r');
        await until(() => f.posts.length === 1);
        expect(f.posts).toEqual([messageText([p1], 'check the big edge')]);
    });

    it('adds a line on shift+enter, alt+enter or ctrl+j, growing the footer, and sends the lines', async () => {
        const f = telling();
        ui = render(<App io={f.io} />);
        ui.stdin.write('m');
        await until(() => footer().startsWith('message s'));
        ui.stdin.write('first');
        await tick();
        ui.stdin.write('\x1b\r'); // shift+enter, as Claude Code's /terminal-setup binds it in VS Code
        await tick();
        ui.stdin.write('second\nthird'); // ctrl+j
        await tick();
        const rows = (ui.lastFrame() ?? '').split('\n').filter(Boolean).slice(-3);
        expect(rows.map((r) => r.trimEnd())).toEqual([
            expect.stringMatching(/^ message s › first {2,}⏎ send/),
            ' second',
            ' third',
        ]);
        ui.stdin.write('\r');
        await until(() => f.posts.length === 1);
        expect(f.posts).toEqual([messageText([p1], 'first\nsecond\nthird')]);
    });

    it('wraps a long line onto rows that start at the left edge, and moves up and down by row', async () => {
        const f = telling();
        ui = render(<App io={f.io} />);
        ui.stdin.write('m');
        await until(() => footer().startsWith('message s'));
        // 100 columns: the first row has room for 50 after the prompt and the hint, the rest for 98.
        const words = Array.from({ length: 24 }, (_, i) => `word${String(i).padStart(2, '0')}`);
        ui.stdin.write(words.join(' '));
        await tick();
        const rows = (ui.lastFrame() ?? '').split('\n').slice(-3);
        expect(rows[0]).toMatch(/^ message s › word00 .* word06 +⏎ send/);
        expect(rows[1]).toMatch(/^ word07 word08 .* word20$/);
        expect(rows[2]).toMatch(/^ word21 word22 word23 *$/);
        const last = () => (ui?.lastFrame() ?? '').split('\n').length - 1;
        expect(cursor.at).toEqual({ x: 1 + 'word21 word22 word23'.length, y: last() });
        ui.stdin.write('\x1b[A'); // up a row, within the same line
        await tick();
        expect(cursor.at).toEqual({ x: 1 + 'word21 word22 word23'.length, y: last() - 1 });
        ui.stdin.write('x');
        await tick();
        ui.stdin.write('\r');
        await until(() => f.posts.length === 1);
        expect(f.posts[0]).toContain('word08 word09x word10');
    });

    it('shows five rows of a longer note, the ones around the cursor', async () => {
        const f = telling();
        ui = render(<App io={f.io} />);
        ui.stdin.write('m');
        await until(() => footer().startsWith('message s'));
        ui.stdin.write('l1\nl2\nl3\nl4\nl5\nl6\nl7');
        await tick();
        const rows = () =>
            (ui?.lastFrame() ?? '')
                .split('\n')
                .slice(-5)
                .map((r) => r.trim());
        // Scrolled: the prompt's row is out of view with l1 and l2.
        expect(rows()).toEqual(['l3', 'l4', 'l5', 'l6', 'l7']);
        ui.stdin.write('\x1b[A\x1b[A\x1b[A\x1b[A\x1b[A'); // up to l2
        await tick();
        expect(rows()).toEqual(['l2', 'l3', 'l4', 'l5', 'l6']);
    });

    it("puts the terminal's own cursor where the note's cursor is, and hides it after", async () => {
        const f = telling();
        ui = render(<App io={f.io} />);
        expect(cursor.at).toBeUndefined();
        ui.stdin.write('m');
        await until(() => footer().startsWith('message s'));
        const last = () => (ui?.lastFrame() ?? '').split('\n').length - 1;
        expect(cursor.at).toEqual({ x: ' message s › '.length, y: last() });
        ui.stdin.write('ab\x1b[D');
        await tick();
        expect(cursor.at).toEqual({ x: ' message s › a'.length, y: last() });
        ui.stdin.write('\n');
        await tick();
        expect(cursor.at).toEqual({ x: 1, y: last() }); // a new line starts at the left edge
        ui.stdin.write('\r');
        await until(() => f.posts.length === 1);
        await tick();
        expect(cursor.at).toBeUndefined();
    });

    it('cancels on Esc with nothing typed: nothing sent, nothing changed', async () => {
        const f = telling();
        ui = render(<App io={f.io} />);
        ui.stdin.write('j');
        await tick();
        const before = f.text();
        ui.stdin.write('m');
        await until(() => footer().startsWith('message s'));
        ui.stdin.write('\x1b');
        await until(() => footer() === 'not sent');
        expect(f.posts).toEqual([]);
        expect(f.text()).toBe(before);
    });

    it('clears a typed note on a second Esc, then cancels on the next', async () => {
        const f = telling();
        ui = render(<App io={f.io} />);
        ui.stdin.write('m');
        await until(() => footer().startsWith('message s'));
        ui.stdin.write('half a thought');
        await tick();
        ui.stdin.write('\x1b');
        await until(() => footer().endsWith('esc again to clear'));
        expect(footer()).toMatch(/^message s › half a thought {2,}esc again to clear$/);
        ui.stdin.write('\x1b');
        await until(() => /^message s › +⏎ send/.test(footer()));
        expect(footer()).toMatch(/^message s › +⏎ send · ⇧⏎ new line · esc cancel$/);
        ui.stdin.write('\x1b');
        await until(() => footer() === 'not sent');
        expect(f.posts).toEqual([]);
    });

    it("says what m needs when no Claude is followed, and doesn't offer it", async () => {
        ui = render(<App io={fakeIo().io} />);
        expect(footer()).not.toContain('m message');
        ui.stdin.write('m');
        await until(() => footer().startsWith('m messages'));
        expect(footer()).toBe('m messages a followed Claude: open the pane with --follow-pid');
    });
});

describe('tsk TUI, asked from outside to select a task', () => {
    /** The app, with the requests it takes handed to the test. */
    function asked() {
        const f = fakeIo();
        let onSelect: ((id: string) => SelectReply) | undefined;
        let stopped = 0;
        const io: TuiIo = {
            ...f.io,
            requests: (handler) => {
                onSelect = handler;
                return () => {
                    stopped++;
                };
            },
        };
        ui = render(<App io={io} />);
        return {
            ask: (id: string) => {
                if (!onSelect) throw new Error('the app takes no requests');
                return onSelect(id);
            },
            stopped: () => stopped,
        };
    }
    const strip = () => ui?.lastFrame()?.split('\n')[0] ?? '';

    it('selects a task the view shows where it is, and says so', async () => {
        const r = asked();
        ui?.stdin.write('?');
        await tick();
        expect(r.ask('b')).toEqual({ ok: true });
        await until(() => position() === '3/4');
        expect(ui?.lastFrame()).toContain('also open'); // still the session view
        expect(ui?.lastFrame()).not.toContain('keys ·'); // the help closed
        expect(footer()).toMatch(/^tsk:b selected, asked from outside/);
    });

    it("switches to the tree for a task this view doesn't show", async () => {
        const r = asked();
        expect(r.ask('p')).toEqual({ ok: true }); // the plan: the session view's crumbs only
        await until(() => position() === '1/5');
        expect(ui?.lastFrame()).not.toContain('also open');
    });

    it('opens the folds above it, and sets aside a filter that leaves it out', async () => {
        const r = asked();
        ui?.stdin.write('2');
        await tick();
        ui?.stdin.write(' '); // fold phase one
        await until(() => position() === '2/3');
        expect(r.ask('a')).toEqual({ ok: true });
        await until(() => position() === '3/5');
        ui?.stdin.write('/two\r');
        await until(() => strip().includes('/two'));
        expect(r.ask('b')).toEqual({ ok: true });
        await until(() => position() === '4/5');
        expect(strip()).not.toContain('/two');
    });

    it("refuses while a filter is typed, and a task the file doesn't have", async () => {
        const r = asked();
        ui?.stdin.write('/');
        await until(() => footer().startsWith('/'));
        const at = position();
        expect(r.ask('b')).toEqual({ ok: false, why: 'busy: a filter is being typed' });
        ui?.stdin.write('\x1b');
        await until(() => !footer().startsWith('/'));
        expect(r.ask('zz')).toEqual({ ok: false, why: 'no task zz in claude.tsk' });
        await tick();
        expect(position()).toBe(at);
    });

    it('stops taking requests when it closes', () => {
        const r = asked();
        ui?.unmount();
        ui = undefined;
        expect(r.stopped()).toBe(1);
    });
});

describe('tsk TUI, a dependency in a file beside it', () => {
    const backlog = buildTaskTree(['- [ ] the backlog item <!-- @id:back1 -->']);
    /** Step b waits on a task in stack.tsk. */
    function beside() {
        const start = fixture.map((l) => l.replace('@id:b ', '@id:b @dependsOn:back1 '));
        const f = fakeIo({ session: 's' }, start);
        const opened: [string, number][] = [];
        const io: TuiIo = {
            ...f.io,
            load: () => withOutside(f.io.load(), [{ file: '/w/stack.tsk', tree: backlog }]),
            openFile: async (file, line) => {
                opened.push([file, line]);
                return undefined;
            },
        };
        return { io, opened, text: f.text };
    }

    it('shows it in the dependency view with its file, and opens that file on e', async () => {
        const b = beside();
        ui = render(<App io={b.io} />);
        ui.stdin.write('jj'); // step b
        await tick();
        expect(ui.lastFrame()).toMatch(/step b {2}◀1/);
        ui.stdin.write('d');
        await until(() => (ui?.lastFrame() ?? '').includes('the backlog item'));
        expect(ui.lastFrame()).toMatch(/the backlog item {2}▶1 {2}stack\.tsk/);
        ui.stdin.write('k'); // the backlog item
        await tick();
        // No zoom: the tree has no place for it.
        expect(footer()).toMatch(/^esc back {2}d deps {2}e open {2}\? keys/);
        ui.stdin.write('\r');
        await until(() => footer().startsWith('back1 is in'));
        expect(footer()).toBe('back1 is in stack.tsk: the tree shows claude.tsk only');
        ui.stdin.write('e');
        await until(() => b.opened.length > 0);
        expect(b.opened).toEqual([['/w/stack.tsk', 0]]);
    });

    it('messages the session about it, naming its file', async () => {
        const b = beside();
        const posts: string[] = [];
        const io: TuiIo = {
            ...b.io,
            tell: async (text) => {
                posts.push(text);
                return () => {};
            },
        };
        ui = render(<App io={io} />);
        ui.stdin.write('jj'); // step b
        await tick();
        ui.stdin.write('d');
        await until(() => (ui?.lastFrame() ?? '').includes('the backlog item'));
        ui.stdin.write('k'); // the backlog item
        await tick();
        ui.stdin.write('m');
        await until(() => footer().startsWith('message s'));
        ui.stdin.write('is this still wanted?\r');
        await until(() => posts.length === 1);
        expect(posts).toEqual([
            messageText(
                [{ id: 'back1', title: 'the backlog item', file: 'stack.tsk' }],
                'is this still wanted?',
            ),
        ]);
    });
});

describe('tsk TUI, a link to a heading', () => {
    const start = fixture.map((l) =>
        l.includes('@id:a ') ? l.replace('step a', 'step a [[plans/x.md#phase-one]]') : l,
    );

    it('shows the linked file, then the heading as it reads, and follows a rename in the plan it shows', async () => {
        const d = detailIo(start);
        ui = render(<App io={d.io} />);
        await until(() => (ui?.lastFrame() ?? '').includes('x.md › Phase one'));
        expect(ui.lastFrame()).toContain('○ step a x.md › Phase one');
        ui.stdin.write('j'); // step a: the pane shows its plan
        await until(() => (ui?.lastFrame() ?? '').includes('x.md:'));
        d.edit(plan().replace('## Phase one', '## Phase uno'));
        await until(() => (ui?.lastFrame() ?? '').includes('x.md#phase-one'));
        expect(ui.lastFrame()).toContain('○ step a x.md#phase-one');
    });
});

describe('the detail pane', () => {
    it("shows the selected task's facts, and its plan opened at the line naming it", async () => {
        ui = render(<App io={detailIo().io} />);
        await tick(); // the plan loads after the first frame
        const frame = ui.lastFrame() ?? '';
        expect(frame).toContain('◐ in progress · p1');
        expect(frame).toContain('in the plan');
        expect(fileLine()).toBe('66');
        expect(frame).toContain('• tsk:p1 phase one in detail');
    });

    it('hides and shows on p', async () => {
        ui = render(<App io={detailIo().io} />);
        await tick(); // the plan loads after the first frame
        ui.stdin.write('p');
        await tick();
        expect(ui.lastFrame()).not.toContain('x.md:');
        ui.stdin.write('p');
        await tick();
        expect(fileLine()).toBe('66');
    });

    it('scrolls on J and K without moving the selection, and opens at the line again for another task', async () => {
        ui = render(<App io={detailIo().io} />);
        await tick(); // the plan loads after the first frame
        ui.stdin.write('J');
        await tick();
        expect(fileLine()).toBe('67');
        ui.stdin.write('JJK');
        await tick();
        expect(fileLine()).toBe('68');
        expect(position()).toBe('1/4');
        ui.stdin.write('j'); // away and back: the pane opens at phase one's line again
        await tick();
        ui.stdin.write('k');
        await tick();
        expect(fileLine()).toBe('66');
    });

    it('redraws when the plan changes', async () => {
        const d = detailIo();
        ui = render(<App io={d.io} />);
        await tick(); // the plan loads after the first frame
        d.edit(plan('phase one, revised'));
        await tick();
        expect(ui.lastFrame()).toContain('phase one, revised');
    });

    it('opens the plan in the editor at the line in view on o', async () => {
        const d = detailIo();
        ui = render(<App io={d.io} />);
        await tick(); // the plan loads after the first frame
        ui.stdin.write('Jo');
        await tick();
        expect(d.opened).toEqual([['/repo/plans/x.md', 66]]);
        expect(footer()).toBe('opened plans/x.md:67 in VS Code');
    });

    it('grows on +, shrinks on -, and goes back on =, several to a read', async () => {
        ui = render(<App io={detailIo().io} />);
        await tick(); // the plan loads after the first frame
        expect(edge()).toBe(60); // 40 of the 100 columns
        ui.stdin.write('+');
        await tick();
        expect(edge()).toBe(55);
        ui.stdin.write('--');
        await tick();
        expect(edge()).toBe(65);
        ui.stdin.write('=');
        await tick();
        expect(edge()).toBe(60);
    });

    it('says how to show the pane when resizing a hidden one', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('+');
        await tick();
        expect(footer()).toBe('p shows the detail pane');
    });

    it("says when a task has no plan, and when its plan can't be read", async () => {
        ui = render(<App io={detailIo(fixture).io} />);
        await tick(); // the plan loads after the first frame
        expect(ui.lastFrame()).toContain('no plan linked');
        ui.unmount();
        const missing = fixture.map((l, i) =>
            i === 0 ? l.replace('the plan', 'the plan [[plans/y.md]]') : l,
        );
        ui = render(<App io={detailIo(missing).io} />);
        await tick(); // the plan loads after the first frame
        expect(ui.lastFrame()).toContain("couldn't read plans/y.md: boom");
    });
});

/** An SGR-1006 report from 0-based coordinates, as a terminal sends it (1-based). */
const sgr = (b: number, x: number, y: number, final: 'M' | 'm' = 'M') =>
    `\x1b[<${b};${x + 1};${y + 1}${final}`;
const click = (x: number, y: number) => sgr(0, x, y) + sgr(0, x, y, 'm');
const WHEEL_DOWN = sgr(65, 0, 5);

/** A tree of `n` todo tasks under one root, for scrolling. */
const many = (n: number) => [
    '- [ ] root <!-- @id:r @session:s -->',
    ...Array.from({ length: n }, (_, i) => `  - [ ] task ${i} <!-- @id:t${i} @session:s -->`),
];

describe('tsk TUI, the mouse', () => {
    // The session view: strip (0), rule (1), crumbs "the plan" (2), then phase one (3),
    // step a (4), step b (5), "also open" (6), phase two (7).
    it('selects the row clicked, on any of its columns, and nothing else', async () => {
        const f = fakeIo();
        ui = render(<App io={f.io} />);
        ui.stdin.write(click(30, 5));
        await tick();
        expect(position()).toBe('3/4'); // step b
        expect(f.text()).toBe(fixture.join('\n'));
    });

    it('zooms in on a double-click, but not on two clicks far apart', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write(click(5, 4));
        await tick(DOUBLE_CLICK_MS + 50);
        ui.stdin.write(click(5, 4));
        await tick();
        expect(ui.lastFrame()).not.toContain('zoomed');
        ui.stdin.write(click(5, 4));
        await tick();
        expect(ui.lastFrame()).toContain('Steps  · zoomed');
        expect(ui.lastFrame()).toContain('step a');
        expect(ui.lastFrame()).not.toContain('phase two');
    });

    it('switches views from the tabs, and zooms into a task from the breadcrumb', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write(click(16, 0)); // " Tree "
        await tick();
        expect(ui.lastFrame()).toContain(' └ ○ phase two');
        ui.stdin.write(click(6, 0)); // " Session "
        await tick();
        expect(ui.lastFrame()).toContain('also open');
        ui.stdin.write(click(2, 2)); // the crumb "the plan"
        await tick();
        expect(ui.lastFrame()).toContain('· zoomed');
        expect(ui.lastFrame()).not.toContain('also open');
    });

    it('goes back from the deps view on "esc back"', async () => {
        ui = render(<App io={fakeIo().io} />);
        ui.stdin.write('d');
        await tick();
        const strip = ui.lastFrame()?.split('\n')[0] ?? '';
        ui.stdin.write(click(strip.indexOf('esc back') + 2, 0));
        await tick();
        expect(ui.lastFrame()).not.toContain('deps of');
    });

    it('scrolls the view with the wheel and leaves the selection, until a key moves it', async () => {
        ui = render(<App io={fakeIo({ session: 's' }, many(40)).io} />);
        ui.stdin.write('\t'); // the tree view; the selection on the root
        await tick();
        ui.stdin.write(WHEEL_DOWN + WHEEL_DOWN);
        await tick();
        expect(ui.lastFrame()?.split('\n')[2]).toBe('  ↑ 6 more');
        expect(position()).toBe('1/41');
        ui.stdin.write('j');
        await tick();
        expect(position()).toBe('2/41');
        expect(ui.lastFrame()).not.toContain('↑');
    });

    it('acts on a footer hint clicked, as its key would', async () => {
        ui = render(<App io={fakeIo().io} />);
        expect(footer()).toMatch(/^d deps/);
        ui.stdin.write(click(2, 23)); // " d deps" at the start of the footer, the last of 24 rows
        await tick();
        expect(ui.lastFrame()).toContain('deps of phase one');
    });

    it('scrolls the detail pane under the pointer, and leaves the list and its selection', async () => {
        ui = render(<App io={detailIo().io} />);
        await tick(); // the plan loads after the first frame
        expect(fileLine()).toBe('66');
        ui.stdin.write(sgr(65, 90, 10)); // side by side at 100 columns: the pane is on the right
        await tick();
        expect(fileLine()).toBe('69');
        ui.stdin.write(click(90, 5));
        await tick();
        expect(position()).toBe('1/4');
    });

    it("drags the detail pane's edge, and a press on it selects nothing", async () => {
        ui = render(<App io={detailIo().io} />);
        await tick(); // the plan loads after the first frame
        expect(edge()).toBe(60);
        ui.stdin.write(sgr(0, 60, 5) + sgr(32, 55, 6) + sgr(32, 50, 6));
        await tick();
        expect(edge()).toBe(50);
        expect(position()).toBe('1/4');
        ui.stdin.write(sgr(0, 50, 6, 'm'));
        await tick();
        // Released: a drag that starts anywhere else moves nothing.
        ui.stdin.write(sgr(0, 20, 4) + sgr(32, 70, 4) + sgr(0, 70, 4, 'm'));
        await tick();
        expect(edge()).toBe(50);
    });

    it('scrolls a page from a "more" line, and ignores releases and other buttons', async () => {
        ui = render(<App io={fakeIo({ session: 's' }, many(40)).io} />);
        ui.stdin.write('\t');
        await tick();
        const rows = ui.lastFrame()?.split('\n') ?? [];
        const more = rows.findIndex((r) => r.includes('↓'));
        ui.stdin.write(sgr(0, 3, more, 'm') + sgr(2, 3, more) + sgr(1, 3, more));
        await tick();
        expect(ui.lastFrame()).not.toContain('↑');
        ui.stdin.write(click(3, more));
        await tick();
        expect(ui.lastFrame()).toMatch(/↑ \d+ more/);
        expect(position()).toBe('1/41');
    });
});
