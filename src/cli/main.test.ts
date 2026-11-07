import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDocument } from '../lib/parser';
import type { OpsDeps } from '../lib/task-ops';
import type { SelectReply } from '../lib/tui-channel';
import { listenForRequests } from '../tui/listen';
import { main, resolveFile } from './main';

/** Sequential ids and a one-second clock, shared by every call in a test. */
function fakeDeps(): OpsDeps {
    let n = 0;
    let t = Date.parse('2026-10-19T10:00:00Z');
    return {
        generateId: () => `t${String(++n).padStart(7, '0')}`,
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

let dir: string;
let file: string;
let deps: OpsDeps;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsk-cli-'));
    file = path.join(dir, 'claude.tsk');
    fs.writeFileSync(file, '');
    deps = fakeDeps();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function tsk(cmd: string, session = 'sess0001-uuid', env: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const argv = cmd.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? [];
    const code = await main({
        argv,
        env: { CLAUDE_CODE_SESSION_ID: session, ...env },
        cwd: dir,
        out: (s) => out.push(s),
        err: (s) => err.push(s),
        deps,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
}

const tasks = () => parseDocument(fs.readFileSync(file, 'utf8'));

describe('tsk command line', () => {
    it('tracks a sidetrack: push nests and focuses, done unwinds to the parent', async () => {
        await tsk('add "the plan" --root --link plans/x.md');
        await tsk('focus t0000001');
        await tsk('push "phase one"');
        await tsk('push "a detour"');
        let trail = (await tsk('trail')).out;
        expect(trail).toContain('3 [/] t0000003 a detour  ← focus');
        expect(trail).toContain('1 [/] t0000001 the plan [[plans/x.md]]');

        const done = await tsk('done');
        expect(done.out).toContain('done  [x] t0000003 a detour');
        expect(done.out).toContain('focus  [/] t0000002 phase one');
        trail = (await tsk('trail')).out;
        expect(trail).toContain('2 [/] t0000002 phase one  ← focus');
        expect(tasks().map((t) => [t.indent.length, t.marker])).toEqual([
            [0, 'inprogress'],
            [2, 'inprogress'],
            [4, 'completed'],
        ]);
    });

    it('add queues under the focus; park puts the focus back for later', async () => {
        await tsk('push "root work"');
        const added = await tsk('add "later"');
        expect(added.out).toBe('added  [ ] t0000002 later  (under t0000001)');
        const parked = await tsk('park');
        expect(parked.out).toContain('parked  [ ] t0000001 root work');
        expect(parked.out).toContain('focus  (none)');
        const trail = (await tsk('trail')).out;
        expect(trail).toContain('no focus');
        expect(trail).toContain('[ ] t0000001 root work');
        expect(trail).toContain('[ ] t0000002 later  (in t0000001)');
    });

    it('hands tasks to agents: the focus stays, the trail lists them, focus takes one back', async () => {
        await tsk('push "the plan"');
        await tsk('add "probe the hooks"');
        expect((await tsk('delegate t0000002 --to alpha')).out).toBe(
            'delegated  [/] t0000002 probe the hooks  (to alpha)\nfocus  [/] t0000001 the plan',
        );
        expect((await tsk('push "read the docs" --to beta')).out).toBe(
            'pushed  [/] t0000003 read the docs  (under t0000001)  (to beta)\nfocus  [/] t0000001 the plan',
        );
        expect((await tsk('add "write it up" --root --to gamma')).out).toBe(
            'added  [/] t0000004 write it up  (to gamma)\nfocus  [/] t0000001 the plan',
        );
        let trail = (await tsk('trail')).out;
        expect(trail).toContain('1 [/] t0000001 the plan  ← focus');
        expect(trail).toContain('nothing open under the focus');
        expect(trail).toContain(
            [
                'with agents:',
                '    [/] t0000002 probe the hooks  (alpha)',
                '    [/] t0000003 read the docs  (beta)',
                '    [/] t0000004 write it up  (gamma)',
            ].join('\n'),
        );
        expect(trail).not.toContain('other open tasks');

        expect((await tsk('done t0000002')).out).toContain('focus  [/] t0000001 the plan');
        expect((await tsk('done')).out).toContain('done  [x] t0000001 the plan');
        await tsk('focus t0000003');
        trail = (await tsk('trail')).out;
        expect(trail).toContain('2 [/] t0000003 read the docs  ← focus');
        expect(trail).not.toContain('(beta)');
        const back = tasks().find((t) => t.metadata.get('id') === 't0000003');
        expect(back?.metadata.has('agent')).toBe(false);
    });

    it('delegate needs a task, --to with a one-word name, and a session', async () => {
        await tsk('add "x" --root');
        expect((await tsk('delegate t0000001')).err).toMatch(/delegate: name the agent with --to/);
        expect((await tsk('delegate --to alpha')).err).toMatch(/delegate: missing the task id/);
        expect((await tsk('delegate t0000001 --to "two words"')).err).toMatch(/agent name/);
        expect((await tsk('add "y" --to alpha', '')).err).toMatch(/no session/);
    });

    it('takes the text from all its words, quoted or not', async () => {
        expect((await tsk('push fix the thing now')).out).toBe(
            'pushed  [/] t0000001 fix the thing now',
        );
        expect((await tsk('add a later one --link plans/x.md')).out).toBe(
            'added  [ ] t0000002 a later one [[plans/x.md]]  (under t0000001)',
        );
    });

    it("keeps each session's focus apart", async () => {
        await tsk('push "mine"', 'aaaaaaaa-1');
        await tsk('push "theirs"', 'bbbbbbbb-2');
        expect((await tsk('trail', 'aaaaaaaa-1')).out).toContain('t0000001 mine  ← focus');
        expect((await tsk('trail', 'bbbbbbbb-2')).out).toContain('t0000002 theirs  ← focus');
        expect((await tsk('ls', 'aaaaaaaa-1')).out).toBe('[/] t0000001 mine');
    });

    it('reports a no-op, a missing task, and a missing focus as such', async () => {
        await tsk('push "x"');
        await tsk('done t0000001');
        expect((await tsk('done t0000001')).out).toContain('done (no change)');
        const missing = await tsk('focus nope');
        expect(missing).toMatchObject({ code: 1, err: 'tsk: no task with @id:nope' });
        expect((await tsk('done')).err).toMatch(/no focus for session sess0001/);
        expect((await tsk('frobnicate')).err).toMatch(/unknown command/);
        expect((await tsk('push')).err).toMatch(/push: missing the task text/);
    });

    it('records a dependency and a link, and shows a task in context', async () => {
        await tsk('add "a" --root');
        await tsk('add "b" --root');
        expect((await tsk('dep t0000002 --on t0000001')).code).toBe(0);
        await tsk('link t0000002 plans/y.md');
        expect(tasks()[1]?.metadata.get('dependsOn')).toBe('t0000001');
        expect(tasks()[1]?.content).toBe('b [[plans/y.md]]');
        await tsk('add "child" --under t0000002');
        expect((await tsk('show t0000003')).out).toBe(
            [
                '  1 [ ] t0000002 b [[plans/y.md]]',
                '  2 [ ] t0000003 child',
                'waits on, through t0000002: [ ] t0000001 a',
                'no children',
            ].join('\n'),
        );
    });

    it('rewords a task from several words, keeping its link and metadata', async () => {
        await tsk('add "the plan" --root --link plans/x.md');
        const metadata = tasks()[0]?.metadata;
        expect((await tsk('reword t0000001 the  new plan')).out).toBe(
            'reworded  [ ] t0000001 the new plan [[plans/x.md]]',
        );
        expect(tasks()[0]?.metadata).toEqual(metadata);
        expect((await tsk('reword t0000001 "the new plan"')).out).toMatch(
            /^reworded \(no change\)/,
        );
        expect((await tsk('reword t0000001')).err).toBe('tsk: reword: missing the new text');
        expect(await tsk('reword t0000001 "a <!-- b"')).toMatchObject({
            code: 1,
            err: 'tsk: the text cannot hold "<!--"',
        });
        expect((await tsk('reword nope x')).err).toBe('tsk: no task with @id:nope');
    });

    it('keeps several dependencies, drops one, and refuses a loop', async () => {
        for (const t of ['a', 'b', 'c']) await tsk(`add "${t}" --root`);
        expect((await tsk('dep t0000003 --on t0000001 --on t0000002')).out).toBe(
            'dep  [ ] t0000003 c  (depends on t0000001, t0000002)',
        );
        expect((await tsk('dep t0000003 --on t0000001,t0000002')).out).toMatch(
            /^dep \(no change\)/,
        );
        expect(await tsk('dep t0000001 --on t0000003')).toMatchObject({
            code: 1,
            err: "tsk: t0000001 can't depend on t0000003: that closes a loop, t0000001 → t0000003 → t0000001",
        });
        expect((await tsk('dep t0000003 --off t0000001')).out).toBe(
            'dep  [ ] t0000003 c  (depends on t0000002)',
        );
        expect((await tsk('dep t0000003')).err).toMatch(/--on <id> or --off <id>/);
        expect((await tsk('show t0000002')).out).toContain('needed by:\n    [ ] t0000003 c');
    });

    it("lists what can start now under the focus's plan, and says what waits", async () => {
        await tsk('add "plan" --root');
        await tsk('focus t0000001');
        await tsk('add "one"'); // t0000002
        await tsk('add "two"'); // t0000003
        await tsk('add "elsewhere" --root'); // t0000004
        await tsk('dep t0000003 --on t0000002');
        expect((await tsk('ready')).out).toBe(
            'ready under [/] t0000001 plan:\n    [ ] t0000002 one',
        );
        expect((await tsk('ready --all')).out).toBe(
            'ready:\n    [ ] t0000002 one  (in t0000001)\n    [ ] t0000004 elsewhere',
        );
        expect((await tsk('trail')).out).toContain('[ ] t0000003 two  (waits on t0000002)');
        await tsk('done t0000002');
        expect((await tsk('ready t0000001')).out).toBe(
            'ready under [/] t0000001 plan:\n    [ ] t0000003 two',
        );
    });

    it('serializes concurrent writers on the file lock', async () => {
        await Promise.all(
            Array.from({ length: 12 }, (_, i) => tsk(`add "task ${i}" --root`, `s${i}`)),
        );
        const written = tasks();
        expect(written).toHaveLength(12);
        expect(new Set(written.map((t) => t.metadata.get('id'))).size).toBe(12);
        expect(fs.existsSync(`${file}.lock`)).toBe(false);
    });

    it('prints the usage for no command and for --help', async () => {
        expect((await tsk('')).out).toMatch(/^tsk: track work/);
        expect((await tsk('--help')).code).toBe(0);
    });
});

describe('dependencies on tasks in the files beside it', () => {
    const backlog = () => path.join(dir, 'stack.tsk');
    beforeEach(async () => {
        fs.writeFileSync(
            backlog(),
            [
                '- [ ] the backlog item <!-- @id:back0001 -->',
                '- [x] a finished one <!-- @id:back0002 -->',
                '- [ ] needs ours <!-- @id:back0003 @dependsOn:t0000001 -->',
            ].join('\n'),
        );
        await tsk('add "ours" --root');
        await tsk('add "waits" --root');
    });

    it('records one, names its file, and holds the task back while it is open', async () => {
        expect((await tsk('dep t0000002 --on back0001')).out).toBe(
            'dep  [ ] t0000002 waits  (depends on back0001)',
        );
        expect((await tsk('show t0000002')).out).toBe(
            [
                '  1 [ ] t0000002 waits',
                'depends on:',
                '    [ ] back0001 the backlog item  (stack.tsk)',
                'no children',
            ].join('\n'),
        );
        expect((await tsk('ready --all')).out).toBe('ready:\n    [ ] t0000001 ours');
        expect(fs.readFileSync(backlog(), 'utf8')).toContain('@id:back0001 -->');
    });

    it("doesn't hold a task back on a finished one there, and lists what there waits on a task here", async () => {
        await tsk('dep t0000002 --on back0002');
        expect((await tsk('ready --all')).out).toBe(
            'ready:\n    [ ] t0000001 ours\n    [ ] t0000002 waits',
        );
        expect((await tsk('show t0000001')).out).toContain(
            'needed by:\n    [ ] back0003 needs ours  (stack.tsk)',
        );
    });

    it('refuses an id in no file, and says which file it could not read', async () => {
        expect((await tsk('dep t0000002 --on nowhere1')).err).toBe(
            'tsk: no task with @id:nowhere1 in this file or beside it',
        );
        fs.mkdirSync(path.join(dir, 'dir.tsk'));
        fs.writeFileSync(path.join(dir, 'locked.tsk'), '- [ ] x');
        fs.chmodSync(path.join(dir, 'locked.tsk'), 0o000);
        const r = await tsk('show t0000002');
        expect(r.code).toBe(0);
        expect(r.err).toMatch(/^tsk: couldn't read locked\.tsk: EACCES/);
    });
});

describe('tsk in a terminal', () => {
    it('writes each id as tsk:<id> in cyan when the output is a terminal, and only then', async () => {
        await tsk('add "the plan" --root');
        const show = async (terminal: boolean, env: Record<string, string> = {}) => {
            const out: string[] = [];
            await main({
                argv: ['show', 't0000001'],
                env: { CLAUDE_CODE_SESSION_ID: 'sess0001-uuid', ...env },
                cwd: dir,
                out: (t) => out.push(t),
                err: () => {},
                deps,
                terminal,
            });
            return out.join('\n');
        };
        expect(await show(true)).toContain('[ ] \u001B[36mtsk:t0000001\u001B[39m the plan');
        expect(await show(true, { NO_COLOR: '1' })).toContain('[ ] tsk:t0000001 the plan');
        expect(await show(true, { NO_COLOR: '' })).toContain('\u001B[36mtsk:t0000001');
        expect(await show(false)).toContain('[ ] t0000001 the plan');
    });
});

describe('tsk show <id> --tui', () => {
    let stop: (() => void) | undefined;
    afterEach(() => stop?.());
    const runtime = () => path.join(dir, 'rt');
    /** A stand-in TUI in this process, showing the file. */
    const tui = async (
        shows: { followPid?: number; session?: string },
        answer: (id: string) => SelectReply = () => ({ ok: true }),
    ) => {
        const asked: string[] = [];
        stop = await listenForRequests({
            dir: runtime(),
            shows: { file: fs.realpathSync(file), ...shows },
            onSelect: (id) => {
                asked.push(id);
                return answer(id);
            },
            onError: (e) => {
                throw e;
            },
        });
        return asked;
    };
    const show = async (id: string, env: Record<string, string>) => {
        const out: string[] = [];
        const err: string[] = [];
        const code = await main({
            argv: ['show', id, '--tui'],
            env: { TSK_RUNTIME_DIR: runtime(), CLAUDE_CONFIG_DIR: dir, ...env },
            cwd: dir,
            out: (t) => out.push(t),
            err: (t) => err.push(t),
            deps,
        });
        return { code, out: out.join('\n'), err: err.join('\n') };
    };
    beforeEach(async () => {
        await tsk('add "the plan" --root');
    });

    it("from a Claude's shell, selects it in the TUI following that Claude", async () => {
        const asked = await tui({ followPid: 4242 });
        expect(await show('t0000001', { CLAUDE_PID: '4242' })).toEqual({
            code: 0,
            out: `selected  [ ] t0000001 the plan  in the TUI pid ${process.pid} (following Claude 4242)`,
            err: '',
        });
        expect(asked).toEqual(['t0000001']);
    });

    it("doesn't ask another Claude's TUI", async () => {
        const asked = await tui({ followPid: 4242 });
        expect(await show('t0000001', { CLAUDE_PID: '999' })).toEqual({
            code: 1,
            out: '',
            err: 'tsk: no TUI on claude.tsk follows this Claude (pid 999); `tsk tui --follow-pid 999` opens one',
        });
        expect(asked).toEqual([]);
    });

    it('from a plain shell, selects it in the TUI showing the session', async () => {
        const asked = await tui({ session: 'sess0001' });
        const r = await show('t0000001', { CLAUDE_CODE_SESSION_ID: 'sess0001-uuid' });
        expect(r.code).toBe(0);
        expect(r.out).toMatch(/in the TUI pid \d+ \(session sess0001\)$/);
        expect(asked).toEqual(['t0000001']);
    });

    it("says why when the TUI won't, when none is open, and when the file has no such task", async () => {
        expect(await show('t0000001', {})).toEqual({
            code: 1,
            out: '',
            err: 'tsk: no TUI is open on claude.tsk; `tsk tui` opens one',
        });
        const asked = await tui({ followPid: 4242 }, () => ({
            ok: false,
            why: 'busy: a note is being typed',
        }));
        expect((await show('t0000001', { CLAUDE_PID: '4242' })).err).toBe(
            `tsk: the TUI pid ${process.pid} (following Claude 4242) didn't select t0000001: busy: a note is being typed`,
        );
        expect(await show('zz', { CLAUDE_PID: '4242' })).toMatchObject({
            code: 1,
            err: 'tsk: no task with @id:zz',
        });
        expect(asked).toEqual(['t0000001']);
    });
});

describe('tsk select-clicked', () => {
    let stop: (() => void) | undefined;
    afterEach(() => stop?.());
    const runtime = () => path.join(dir, 'rt');
    const socket = '/tmp/tmux-test/default';
    /** A stand-in TUI in this process, in tmux pane `pane`. */
    const tui = async (
        pane: string,
        answer: (id: string) => SelectReply = () => ({ ok: true }),
    ) => {
        const asked: string[] = [];
        stop = await listenForRequests({
            dir: runtime(),
            shows: { file: fs.realpathSync(file), tmux: { socket, pane } },
            onSelect: (id) => {
                asked.push(id);
                return answer(id);
            },
            onError: (e) => {
                throw e;
            },
        });
        return asked;
    };
    /** A Ctrl+Click in pane %1, whose window holds %1 and %2, from client /dev/pts/3. */
    const click = async (line: string, column: number, extra: string[] = []) => {
        const out: string[] = [];
        const err: string[] = [];
        const tmux: string[][] = [];
        const code = await main({
            argv: [
                'select-clicked',
                '--pane=%1',
                '--client=/dev/pts/3',
                `--column=${column}`,
                `--line=${line}`,
                ...extra,
            ],
            env: { TSK_RUNTIME_DIR: runtime(), TMUX: `${socket},123,0` },
            // tmux runs it in its own working directory, where there's no claude.tsk.
            cwd: os.tmpdir(),
            out: (t) => out.push(t),
            err: (t) => err.push(t),
            tmux: async (s, args) => {
                tmux.push([s, ...args]);
                return args[0] === 'list-panes' ? '%1\n%2\n' : '';
            },
        });
        return { code, out: out.join('\n'), err: err.join('\n'), tmux };
    };
    const told = (text: string) => [socket, 'display-message', '-l', '-c', '/dev/pts/3', text];

    it('selects the tsk:<id> under the mouse in the TUI in the same window', async () => {
        const asked = await tui('%2');
        const r = await click('- see tsk:t0000001 for it', 8);
        expect(r).toMatchObject({
            code: 0,
            out: `selected tsk:t0000001 in the TUI pid ${process.pid}`,
            err: '',
        });
        expect(r.tmux).toEqual([[socket, 'list-panes', '-t', '%1', '-F', '#{pane_id}']]);
        expect(asked).toEqual(['t0000001']);
    });

    it("takes the id from the extension's link under the mouse", async () => {
        const asked = await tui('%2');
        const r = await click('[ ] t0000001 the plan', 4, [
            '--hyperlink=vscode://garyng.tsk/open?id=t0000001',
        ]);
        expect(r.code).toBe(0);
        expect(asked).toEqual(['t0000001']);
    });

    it('does nothing for a click on no task', async () => {
        const asked = await tui('%2');
        expect(await click('- see tsk:t0000001 for it', 2, ['--hyperlink='])).toEqual({
            code: 0,
            out: '',
            err: '',
            tmux: [],
        });
        expect(asked).toEqual([]);
    });

    it('tells the client when no TUI is in the window, and asks none elsewhere', async () => {
        const asked = await tui('%9');
        const r = await click('tsk:t0000001', 0);
        expect(r.code).toBe(0);
        expect(r.err).toBe('tsk: no TUI beside this pane; `tsk tmux-pane` opens one');
        expect(r.tmux.at(-1)).toEqual(
            told('tsk: no TUI beside this pane; `tsk tmux-pane` opens one'),
        );
        expect(asked).toEqual([]);
    });

    it("tells the client why the TUI didn't select it", async () => {
        await tui('%2', (id) => ({ ok: false, why: `no task ${id} in claude.tsk` }));
        const r = await click('tsk:zz', 0);
        expect(r.code).toBe(0);
        expect(r.tmux.at(-1)).toEqual(told('tsk: tsk:zz not selected: no task zz in claude.tsk'));
    });

    it('needs what tmux passes, and tmux', async () => {
        const r = await click('tsk:t0000001', Number.NaN);
        expect(r).toMatchObject({
            code: 1,
            err: expect.stringMatching(/^tsk: select-clicked: needs/),
        });
        const outside = await main({
            argv: [
                'select-clicked',
                '--pane=%1',
                '--client=c',
                '--column=0',
                '--line=tsk:t0000001',
            ],
            env: { TSK_RUNTIME_DIR: runtime() },
            cwd: dir,
            out: () => {},
            err: () => {},
        });
        expect(outside).toBe(1);
    });
});

describe('tsk commit', () => {
    /** git with no config from outside the test: no signing, no global hooks. */
    let gitEnv: Record<string, string>;
    const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8' });
    const commit = (session = 'sess0001-uuid') => tsk('commit', session, gitEnv);

    beforeEach(() => {
        gitEnv = {
            PATH: process.env.PATH ?? '',
            HOME: dir,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CEILING_DIRECTORIES: path.dirname(dir),
            GIT_AUTHOR_NAME: 't',
            GIT_AUTHOR_EMAIL: 't@example.com',
            GIT_COMMITTER_NAME: 't',
            GIT_COMMITTER_EMAIL: 't@example.com',
        };
        git('init', '-q');
        fs.writeFileSync(path.join(dir, 'other.txt'), 'one\n');
        git('add', 'claude.tsk', 'other.txt');
        git('commit', '-q', '-m', 'start');
    });

    it("commits the file whole, every session's tasks, and nothing else that's staged", async () => {
        await tsk('add "mine" --root', 'sess0001-uuid');
        await tsk('add "theirs" --root', 'sess0002-uuid');
        fs.writeFileSync(path.join(dir, 'other.txt'), 'two\n');
        git('add', 'other.txt');

        const done = await commit();
        expect(done.code).toBe(0);
        expect(done.out).toMatch(
            /^committed claude\.tsk as [0-9a-f]+: chore: claude\.tsk from sess0001, sess0002$/,
        );
        expect(git('show', '--name-only', '--format=', 'HEAD').trim()).toBe('claude.tsk');
        expect(git('log', '-1', '--format=%B')).toContain(
            'sess0001:\n  added tsk:t0000001 mine\nsess0002:\n  added tsk:t0000002 theirs',
        );
        expect(git('show', 'HEAD:claude.tsk')).toBe(fs.readFileSync(file, 'utf8'));
        // What someone else staged is still staged; the committed file isn't left looking staged.
        expect(git('status', '--porcelain').trim()).toBe('M  other.txt');
    });

    it('with nothing changed since HEAD, says so and commits nothing', async () => {
        const head = git('rev-parse', 'HEAD');
        const done = await commit();
        expect(done).toMatchObject({ code: 0, out: 'nothing to commit: claude.tsk matches HEAD' });
        expect(git('rev-parse', 'HEAD')).toBe(head);
    });

    it('commits a file git has not seen yet', async () => {
        git('rm', '-q', '--cached', 'claude.tsk');
        git('commit', '-q', '-m', 'untrack');
        await tsk('add "first" --root');
        const done = await commit();
        expect(done.code).toBe(0);
        expect(git('log', '-1', '--format=%B')).toContain('added tsk:t0000001 first');
        expect(git('status', '--porcelain', '--', 'claude.tsk')).toBe('');
    });

    it("stops at a hook that refuses, with git's words, and leaves HEAD where it was", async () => {
        const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
        fs.writeFileSync(hook, '#!/bin/sh\necho "not today" >&2\nexit 1\n', { mode: 0o755 });
        await tsk('add "mine" --root');
        const head = git('rev-parse', 'HEAD');
        const done = await commit();
        expect(done.code).toBe(1);
        expect(done.err).toContain('tsk: git commit failed: not today');
        expect(git('rev-parse', 'HEAD')).toBe(head);
        expect(git('status', '--porcelain', '--', 'claude.tsk')).toBe(' M claude.tsk\n');
    });

    it('refuses a file outside a repository, or one git ignores', async () => {
        // git ignores only what it doesn't track.
        git('rm', '-q', '--cached', 'claude.tsk');
        fs.writeFileSync(path.join(dir, '.gitignore'), 'claude.tsk\n');
        expect((await commit()).err).toBe('tsk: git ignores claude.tsk');
        fs.rmSync(path.join(dir, '.git'), { recursive: true });
        const outside = await commit();
        expect(outside.code).toBe(1);
        expect(outside.err).toMatch(/isn't in a git repository$/);
    });
});

describe('resolveFile', () => {
    it('prefers --file, then TSK_FILE, then the nearest claude.tsk above the working directory', () => {
        const nested = path.join(dir, 'a', 'b');
        fs.mkdirSync(nested, { recursive: true });
        expect(resolveFile('x.tsk', {}, nested)).toBe(path.join(nested, 'x.tsk'));
        expect(resolveFile(undefined, { TSK_FILE: '/elsewhere.tsk' }, nested)).toBe(
            '/elsewhere.tsk',
        );
        expect(resolveFile(undefined, {}, nested)).toBe(file);
        fs.rmSync(file);
        expect(() => resolveFile(undefined, {}, nested)).toThrow(/no claude.tsk/);
    });
});

describe('tsk tmux-pane', () => {
    it('opens the TUI on the file it found, run by the same tsk', async () => {
        // This process stands in for the Claude: its pane is the one on its stdin.
        const tty = fs.readlinkSync('/proc/self/fd/0');
        const calls: string[][] = [];
        const out: string[] = [];
        const code = await main({
            argv: ['tmux-pane'],
            env: {
                TMUX: '/tmp/tmux-test/default,123,0',
                CLAUDE_PID: String(process.pid),
                TSK_RUNTIME_DIR: path.join(dir, 'rt'),
            },
            cwd: dir,
            out: (t) => out.push(t),
            err: (t) => out.push(t),
            self: ['/usr/bin/node', '/opt/tsk/tsk.mjs'],
            tmux: async (_socket, args) => {
                calls.push([...args]);
                return args[0] === 'split-window' ? '%9\n' : `%1 ${tty}\n`;
            },
        });
        expect(out).toEqual([
            `opened tsk tui in pane %9, following Claude pid ${process.pid} (q in it to close)`,
        ]);
        expect(code).toBe(0);
        expect(calls.at(-1)).toEqual(
            expect.arrayContaining(['-t', '%1', '-c', dir, 'tui', '--file', file]),
        );
        expect(calls.at(-1)?.slice(-7, -4)).toEqual(['/usr/bin/node', '/opt/tsk/tsk.mjs', 'tui']);
    });
});
