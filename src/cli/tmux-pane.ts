import path from 'node:path';
import { liveRecords, runtimeDir, tmuxSocket } from '../lib/tui-channel';
import { runningClaudes, tmuxError, ttyOfPid } from '../tui/claude-panes';
import { claudeConfigDir } from '../tui/follow';
import { runTmux, type Tmux } from './select-clicked';

/**
 * `tsk tmux-pane`: the TUI in a tmux pane beside a Claude, following it, run
 * from Claude's own shell or from anywhere in its window (a popup over it
 * too); `--here` runs the TUI in the current pane instead, as a restored tsk
 * pane can.
 */

export interface TmuxPaneIo {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
    readonly tmux?: Tmux;
    /** The terminal a process reads its keys from; undefined when it's gone. */
    readonly ttyOf?: (pid: number) => string | undefined;
}

export interface TmuxPaneOptions {
    readonly file: string;
    /** Run the TUI in this pane instead of opening one. */
    readonly here: boolean;
    readonly mouse: boolean;
    /** How to run this tsk again: node and the bundle running now. */
    readonly self: readonly string[];
    /** Runs the TUI in this process, following `pid`; its exit code. */
    readonly runTui: (pid: number) => Promise<number>;
}

/** `list-panes -F` output: each line's fields, the last one holding the rest of the line. */
const panes = (out: string) =>
    out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
            const [pane = '', a = '', ...rest] = l.split(' ');
            return { pane, a, b: rest.join(' ') };
        });

export async function tmuxPane(opts: TmuxPaneOptions, io: TmuxPaneIo): Promise<number> {
    const fail = (why: string) => {
        io.err(`tsk: ${why}`);
        return 1;
    };
    const named = io.env.CLAUDE_PID ? Number(io.env.CLAUDE_PID) : undefined;
    if (named !== undefined && !Number.isInteger(named))
        return fail(`CLAUDE_PID is "${io.env.CLAUDE_PID}", not a process id`);
    const socket = tmuxSocket(io.env);
    if (!socket) {
        const elsewhere = `; run \`tsk tui --follow-pid ${named}\` in another terminal`;
        return fail(`not in tmux${named === undefined ? '' : elsewhere}`);
    }
    const tmux = (args: readonly string[]) => (io.tmux ?? runTmux)(socket, args);
    const ttyOf = io.ttyOf ?? ttyOfPid;

    const claude = await findClaude(named, opts.here, tmux, ttyOf, io.env).catch(tmuxError);
    if (typeof claude === 'string') return fail(claude);
    if (opts.here) return await opts.runTui(claude.pid);
    try {
        const open = await openFor(claude, socket, tmux, io);
        if (open) {
            io.out(`already open in pane ${open} (q in it to close)`);
            return 0;
        }
        // -d keeps the keyboard on Claude. Several words, so tmux runs them without a shell.
        const tui = [...opts.self, 'tui', '--file', opts.file];
        if (!opts.mouse) tui.push('--no-mouse');
        tui.push('--follow-pid', String(claude.pid));
        const config = `CLAUDE_CONFIG_DIR=${claudeConfigDir(io.env)}`;
        const split = ['split-window', '-h', '-d', '-l', '25%', '-t', claude.pane];
        const where = ['-c', path.dirname(opts.file), '-e', config, '-P', '-F', '#{pane_id}'];
        const pane = (await tmux([...split, ...where, ...tui])).trim();
        io.out(
            `opened tsk tui in pane ${pane}, following Claude pid ${claude.pid} (q in it to close)`,
        );
        return 0;
    } catch (e) {
        return fail(tmuxError(e));
    }
}

type RunTmux = (args: readonly string[]) => Promise<string>;
type PaneClaude = { readonly pid: number; readonly pane: string };

/** The Claude to follow and its pane, else why there's none. */
async function findClaude(
    named: number | undefined,
    here: boolean,
    tmux: RunTmux,
    ttyOf: (pid: number) => string | undefined,
    env: TmuxPaneIo['env'],
): Promise<PaneClaude | string> {
    if (named !== undefined) {
        // From Claude's own shell: that Claude, wherever focus is.
        const tty = ttyOf(named);
        if (!tty) return `Claude pid ${named} has exited`;
        const all = panes(await tmux(['list-panes', '-a', '-F', '#{pane_id} #{pane_tty}']));
        const pane = all.find((p) => p.a === tty)?.pane;
        return pane ? { pid: named, pane } : `Claude pid ${named} isn't in a tmux pane`;
    }
    // Untargeted, list-panes is the window of $TMUX_PANE's (not the pane itself), or of
    // the popup's client. The active
    // pane's Claude first: the palette's popup leaves Claude's pane active. Then the last
    // pane's, the one left to come here: typed in a shell, the shell is the active one.
    const format = '#{pane_id} #{pane_tty} #{?pane_active,active,#{?pane_last,last,}}';
    const window = panes(await tmux(['list-panes', '-F', format]));
    const inWindow = runningClaudes(claudeConfigDir(env)).flatMap(({ pid }) => {
        const tty = ttyOf(pid);
        const p = tty && window.find((w) => w.a === tty);
        return p ? [{ pid, pane: p.pane, focus: p.b }] : [];
    });
    const at = (focus: string) => inWindow.filter((c) => c.focus === focus);
    const [claude, ...more] = [at('active'), at('last')].find((c) => c.length > 0) ?? inWindow;
    const none = 'no Claude in this window';
    if (!claude) return here ? `${none}; start it, then run this again` : none;
    if (more.length > 0)
        return 'more than one Claude in this window: select the one to follow, then run this again';
    return { pid: claude.pid, pane: claude.pane };
}

/**
 * The pane in Claude's window already showing a TUI that follows it: one a
 * split made, by its command, or one started any other way (`--here`), by its
 * record. One pane per Claude in a window.
 */
async function openFor(
    claude: PaneClaude,
    socket: string,
    tmux: RunTmux,
    io: TmuxPaneIo,
): Promise<string | undefined> {
    // The start command last: it has spaces. tmux shows several words as words, one as "…".
    const window = panes(
        await tmux(['list-panes', '-t', claude.pane, '-F', '#{pane_id} #{pane_start_command}']),
    ).map((p) => ({ pane: p.pane, start: `${p.a} ${p.b}` }));
    // As grep -w would: pid 12's pane isn't pid 123's.
    const follows = new RegExp(`(^|\\s)--follow-pid ${claude.pid}(\\s|"|$)`);
    const started = window.find((p) => follows.test(p.start))?.pane;
    if (started) return started;
    const ids = new Set(window.map((p) => p.pane));
    let live: ReturnType<typeof liveRecords> = [];
    try {
        live = liveRecords(runtimeDir(io.env));
    } catch (e) {
        io.err(`tsk: won't read the TUIs' records: ${(e as Error).message}`);
    }
    const tui = live.find(
        (r) => r.followPid === claude.pid && r.tmux?.socket === socket && ids.has(r.tmux.pane),
    );
    return tui?.tmux?.pane;
}
