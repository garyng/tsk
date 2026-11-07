import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processStart } from '../lib/process-start';
import { makeRuntimeDir, recordPath, type TuiRecord } from '../lib/tui-channel';
import { type TmuxPaneOptions, tmuxPane } from './tmux-pane';

let dir: string;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsk-tmux-pane-'));
    fs.mkdirSync(path.join(dir, 'config', 'sessions'), { recursive: true });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const socket = '/tmp/tmux-1000/default';
const file = '/repo/claude.tsk';
// Two Claudes that are running: this test and the process that started it.
const A = process.pid;
const B = process.ppid;
const claudes = () => {
    for (const [pid, session] of [
        [A, 'aaaa0001'],
        [B, 'bbbb0001'],
    ] as const) {
        const body = JSON.stringify({ pid, sessionId: session, procStart: processStart(pid) });
        fs.writeFileSync(path.join(dir, 'config', 'sessions', `${pid}.json`), body);
    }
};
const ttys: Record<number, string> = { [A]: '/dev/pts/3', [B]: '/dev/pts/7' };

/** The untargeted `list-panes`' format: each pane's id, tty, and `active`, `last` or nothing. */
const FOCUS = '#{pane_id} #{pane_tty} #{?pane_active,active,#{?pane_last,last,}}';

/**
 * `tsk tmux-pane` against a stand-in tmux: `window` is the window's panes as
 * `id tty focus start-command`, focus `1` for the active pane, `L` for the
 * last one (left to come to the active one) and `0` for the rest; the
 * untargeted `list-panes` lists it.
 */
async function run(
    window: string[],
    { env = {}, here = false, mouse = true, split = '%20\n' as string | Error } = {},
) {
    const out: string[] = [];
    const err: string[] = [];
    const calls: string[][] = [];
    const ran: number[] = [];
    const fields = (...is: number[]) =>
        window.map((p) => is.map((i) => p.split(' ')[i]).join(' ')).join('\n');
    const opts: TmuxPaneOptions = {
        file,
        here,
        mouse,
        self: ['/usr/bin/node', '/opt/tsk/tsk.mjs'],
        runTui: async (pid) => {
            ran.push(pid);
            return 0;
        },
    };
    const code = await tmuxPane(opts, {
        env: {
            TMUX: `${socket},123,0`,
            CLAUDE_CONFIG_DIR: path.join(dir, 'config'),
            TSK_RUNTIME_DIR: path.join(dir, 'rt'),
            ...env,
        },
        out: (t) => out.push(t),
        err: (t) => err.push(t),
        ttyOf: (pid) => ttys[pid],
        tmux: async (s, args) => {
            expect(s).toBe(socket);
            calls.push([...args]);
            const format = args.at(-1) ?? '';
            if (args[0] === 'split-window') {
                if (split instanceof Error) throw split;
                return split;
            }
            if (format === FOCUS)
                return fields(0, 1, 2)
                    .replace(/ 1$/gm, ' active')
                    .replace(/ L$/gm, ' last')
                    .replace(/ 0$/gm, ' ');
            if (format === '#{pane_id} #{pane_tty}') return fields(0, 1);
            if (format === '#{pane_id} #{pane_start_command}')
                return window
                    .map((p) => {
                        const [id, , , ...start] = p.split(' ');
                        return `${id} ${start.join(' ')}`;
                    })
                    .join('\n');
            throw new Error(`unexpected tmux ${args.join(' ')}`);
        },
    });
    return { code, out: out.join('\n'), err: err.join('\n'), calls, ran };
}

describe('tsk tmux-pane', () => {
    beforeEach(claudes);
    const shell = '%4 /dev/pts/4 1 bash';

    it("splits the window's Claude's pane, the active one being a shell beside it", async () => {
        const r = await run(['%3 /dev/pts/3 0 claude', shell]);
        expect(r).toMatchObject({
            code: 0,
            out: `opened tsk tui in pane %20, following Claude pid ${A} (q in it to close)`,
            err: '',
        });
        expect(r.calls.at(-1)).toEqual([
            ...['split-window', '-h', '-d', '-l', '25%', '-t', '%3', '-c', '/repo'],
            ...['-e', `CLAUDE_CONFIG_DIR=${path.join(dir, 'config')}`, '-P', '-F', '#{pane_id}'],
            ...['/usr/bin/node', '/opt/tsk/tsk.mjs', 'tui', '--file', file],
            ...['--follow-pid', String(A)],
        ]);
    });

    it("takes the active pane's Claude of several, and refuses when none of them is active", async () => {
        const two = ['%3 /dev/pts/3 0 claude', '%7 /dev/pts/7 0 claude'];
        expect((await run([...two, shell])).err).toBe(
            'tsk: more than one Claude in this window: select the one to follow, then run this again',
        );
        const r = await run(['%3 /dev/pts/3 0 claude', '%7 /dev/pts/7 1 claude']);
        expect(r.calls.at(-1)?.slice(-2)).toEqual(['--follow-pid', String(B)]);
    });

    it('takes the Claude of the pane left to come here: typed in a shell, the shell is the active one', async () => {
        const r = await run(['%3 /dev/pts/3 0 claude', '%7 /dev/pts/7 L claude', shell]);
        expect(r.err).toBe('');
        expect(r.calls.at(-1)?.slice(-2)).toEqual(['--follow-pid', String(B)]);
    });

    it("splits $CLAUDE_PID's pane wherever it is, from Claude's own shell", async () => {
        const r = await run(['%3 /dev/pts/3 1 claude', '%7 /dev/pts/7 0 claude'], {
            env: { CLAUDE_PID: String(B) },
        });
        expect(r.calls[0]).toEqual(['list-panes', '-a', '-F', '#{pane_id} #{pane_tty}']);
        expect(r.calls.at(-1)).toContain('%7');
        expect(r.out).toContain(`following Claude pid ${B}`);
    });

    it('says where, instead of opening a second, when one follows that Claude', async () => {
        const tui = `%5 /dev/pts/5 0 /usr/bin/node /opt/tsk/tsk.mjs tui --file ${file} --follow-pid ${A}`;
        const r = await run(['%3 /dev/pts/3 0 claude', tui, shell]);
        expect(r).toMatchObject({ code: 0, out: 'already open in pane %5 (q in it to close)' });
        expect(r.calls.map((c) => c[0])).not.toContain('split-window');
        // tmux shows a command given as one word in quotes.
        const quoted = `%5 /dev/pts/5 0 "tsk tui --follow-pid ${A}"`;
        expect((await run(['%3 /dev/pts/3 0 claude', quoted])).out).toMatch(/^already open/);
    });

    it("doesn't take a pane following a longer pid for this one's", async () => {
        const other = `%5 /dev/pts/5 0 tsk tui --follow-pid ${A}0`;
        expect((await run(['%3 /dev/pts/3 0 claude', other])).out).toMatch(/^opened/);
    });

    it("finds a TUI started some other way by its record, in the window's panes only", async () => {
        const rt = path.join(dir, 'rt');
        makeRuntimeDir(rt);
        const record = (pane: string): TuiRecord => ({
            pid: process.pid,
            procStart: processStart(process.pid),
            file,
            followPid: A,
            tmux: { socket, pane },
        });
        const window = ['%3 /dev/pts/3 0 claude', '%5 /dev/pts/5 0 bash', shell];
        fs.writeFileSync(recordPath(rt, process.pid), JSON.stringify(record('%9')));
        expect((await run(window)).out).toMatch(/^opened/);
        fs.writeFileSync(recordPath(rt, process.pid), JSON.stringify(record('%5')));
        expect((await run(window)).out).toBe('already open in pane %5 (q in it to close)');
    });

    it("runs the TUI in this pane on --here, following the window's Claude", async () => {
        const r = await run(['%3 /dev/pts/3 0 claude', shell], { here: true });
        expect(r.ran).toEqual([A]);
        expect(r.calls.map((c) => c[0])).toEqual(['list-panes']);
    });

    it('passes --no-mouse on', async () => {
        const r = await run(['%3 /dev/pts/3 0 claude'], { mouse: false });
        expect(r.calls.at(-1)?.slice(-3)).toEqual(['--no-mouse', '--follow-pid', String(A)]);
    });

    it('says why when there is no Claude to follow', async () => {
        expect((await run([shell])).err).toBe('tsk: no Claude in this window');
        expect((await run([shell], { here: true })).err).toBe(
            'tsk: no Claude in this window; start it, then run this again',
        );
        const gone = await run([shell], { env: { CLAUDE_PID: '4194303' } });
        expect(gone).toMatchObject({ code: 1, err: 'tsk: Claude pid 4194303 has exited' });
        expect((await run([shell], { env: { CLAUDE_PID: String(A) } })).err).toBe(
            `tsk: Claude pid ${A} isn't in a tmux pane`,
        );
        expect((await run([shell], { env: { CLAUDE_PID: 'x' } })).err).toBe(
            'tsk: CLAUDE_PID is "x", not a process id',
        );
    });

    it('says to run the TUI elsewhere outside tmux', async () => {
        expect((await run([], { env: { TMUX: '' } })).err).toBe('tsk: not in tmux');
        expect((await run([], { env: { TMUX: '', CLAUDE_PID: '42' } })).err).toBe(
            'tsk: not in tmux; run `tsk tui --follow-pid 42` in another terminal',
        );
    });

    it("reports tmux's own error", async () => {
        const split = Object.assign(new Error('failed'), { stderr: 'no space for a new pane\n' });
        const r = await run(['%3 /dev/pts/3 0 claude'], { split });
        expect(r).toMatchObject({ code: 1, err: 'tsk: tmux: no space for a new pane' });
        // execFile's timeout, which says only "Command failed".
        const slow = Object.assign(new Error('Command failed: tmux'), { killed: true, stderr: '' });
        expect((await run(['%3 /dev/pts/3 0 claude'], { split: slow })).err).toBe(
            "tsk: tmux didn't answer within 1 s",
        );
    });
});
