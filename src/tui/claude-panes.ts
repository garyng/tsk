import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { processStart } from '../lib/process-start';
import { shortSessionId } from '../lib/session-focus';
import { tmuxSocket } from '../lib/tui-channel';

/**
 * Which Claude is on a session now, and the tmux pane it runs in, for `s`.
 * Each running Claude keeps `<config>/sessions/<pid>.json` (`follow.ts`); its
 * pane is the one whose tty is the Claude's stdin, which holds however Claude
 * was started there.
 */

/** The running Claudes' pids, by the short session id each is on now. */
export function runningSessions(configDir: string): Map<string, number> {
    const dir = path.join(configDir, 'sessions');
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`tsk: ${dir}: ${e}`);
        return new Map();
    }
    const running = new Map<string, number>();
    for (const name of names) {
        const pid = /^(\d+)\.json$/.exec(name)?.[1];
        // Most files are of Claudes that have exited: /proc is asked first (a failed read costs
        // more), and the file read only for a process that's there. 1.3 ms for 203 files.
        const start = pid && fs.existsSync(`/proc/${pid}`) && processStart(Number(pid));
        if (!pid || !start) continue;
        try {
            const file = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
            // A pid can be reused: the file counts only if its process started when it says.
            if (file.sessionId && String(file.procStart) === start)
                running.set(shortSessionId(file.sessionId), Number(pid));
        } catch {
            // Read every poll, mid-write too: a file that doesn't parse is left out until it does.
        }
    }
    return running;
}

/** Runs tmux against the server the TUI is in; resolves to what it printed. */
export type Tmux = (args: readonly string[]) => Promise<string>;

/** tmux answers at once; one that doesn't isn't worth holding the key for. */
const TMUX_TIMEOUT_MS = 1000;
const run = promisify(execFile);

export interface SwitchIo {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly tmux?: Tmux;
    /** The terminal a process reads its keys from; undefined when it's gone. */
    readonly ttyOf?: (pid: number) => string | undefined;
}

const ttyOfPid = (pid: number) => {
    try {
        return fs.readlinkSync(`/proc/${pid}/fd/0`);
    } catch {
        return undefined;
    }
};

/**
 * Move the tmux client showing this pane to the pane Claude `pid` runs in:
 * its session, window and pane, the keyboard on Claude, and the session left
 * the client's last (prefix L goes back). Undefined on success, else why not.
 */
export async function switchToClaude(pid: number, io: SwitchIo): Promise<string | undefined> {
    const socket = tmuxSocket(io.env);
    if (!socket) return 'not in tmux';
    const tmux: Tmux =
        io.tmux ??
        ((args) =>
            run('tmux', ['-S', socket, ...args], { timeout: TMUX_TIMEOUT_MS }).then(
                (r) => r.stdout,
            ));
    const tty = (io.ttyOf ?? ttyOfPid)(pid);
    if (!tty) return 'its Claude has exited';
    try {
        const panes = await tmux(['list-panes', '-a', '-F', '#{pane_tty} #{pane_id}']);
        const pane = panes
            .split('\n')
            .map((l) => l.split(' '))
            .find(([t]) => t === tty)?.[1];
        if (!pane) return "its Claude isn't in a tmux pane";
        await tmux(['switch-client', '-t', pane]);
        return undefined;
    } catch (e) {
        const why = (e as { stderr?: string }).stderr?.trim() || (e as Error).message;
        return `tmux: ${why}`;
    }
}
