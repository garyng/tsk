import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { type Click, clickedTaskId } from '../lib/clicked-task';
import {
    askTui,
    checkRuntimeDir,
    isAlive,
    readRecords,
    runtimeDir,
    type TuiRecord,
    tmuxSocket,
} from '../lib/tui-channel';

/** Runs tmux against the server at `socket`; resolves to what it printed. */
export type Tmux = (socket: string, args: readonly string[]) => Promise<string>;

const run = promisify(execFile);
/** tmux answers at once; one that doesn't isn't worth holding the click for. */
const TMUX_TIMEOUT_MS = 1000;
const runTmux: Tmux = (socket, args) =>
    run('tmux', ['-S', socket, ...args], { timeout: TMUX_TIMEOUT_MS }).then((r) => r.stdout);

export interface ClickIn extends Click {
    /** `%<n>`: the pane clicked. */
    readonly pane: string;
    /** The tmux client the click came from, to tell why nothing was selected. */
    readonly client: string;
}

export interface SelectClickedIo {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
    readonly tmux?: Tmux;
}

/**
 * `tsk select-clicked`, which a tmux binding runs on a Ctrl+Click (README):
 * select the task under the mouse in the TUIs in the clicked pane's window, as
 * a click in VS Code's terminal does (`terminal-tui.ts`). With no task there,
 * nothing happens. Why a clicked task wasn't selected goes to tmux's message
 * line, and the exit is 0 then too: tmux would put a failed command's status
 * over the pane. The TUI's footer says when it was.
 */
export async function selectClicked(click: ClickIn, io: SelectClickedIo): Promise<number> {
    const id = clickedTaskId(click);
    if (!id) return 0;
    const socket = tmuxSocket(io.env);
    if (!socket) {
        io.err('tsk: select-clicked: TMUX is unset');
        return 1;
    }
    const tmux = io.tmux ?? runTmux;
    const tell = async (text: string) => {
        io.err(`tsk: ${text}`);
        await tmux(socket, ['display-message', '-l', '-c', click.client, `tsk: ${text}`]);
        return 0;
    };
    const dir = runtimeDir(io.env);
    let live: TuiRecord[] = [];
    if (fs.existsSync(dir)) {
        try {
            checkRuntimeDir(dir);
        } catch (e) {
            return tell(`won't ask the TUIs: ${(e as Error).message}`);
        }
        live = readRecords(dir).filter(isAlive);
    }
    const listed = await tmux(socket, ['list-panes', '-t', click.pane, '-F', '#{pane_id}']);
    const window = new Set(listed.split('\n').map((l) => l.trim()));
    const beside = live.filter((r) => r.tmux?.socket === socket && window.has(r.tmux.pane));
    if (beside.length === 0) return tell('no TUI beside this pane; `tsk tui` opens one');
    const why: string[] = [];
    for (const r of beside) {
        const reply = await askTui(dir, r.pid, id).catch((e: Error) => ({
            ok: false as const,
            why: e.message,
        }));
        if (reply.ok) io.out(`selected tsk:${id} in the TUI pid ${r.pid}`);
        else why.push(reply.why);
    }
    return why.length < beside.length ? 0 : tell(`tsk:${id} not selected: ${why.join('; ')}`);
}
