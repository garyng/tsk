import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { processStart } from '../lib/process-start';
import { shortSessionId } from '../lib/session-focus';
import { tmuxSocket } from '../lib/tui-channel';

/**
 * Which Claude is on a session now, and the tmux pane it runs in, for `s`
 * and `tsk tmux-pane`. Each running Claude keeps `<config>/sessions/<pid>.json`
 * (`follow.ts`); its pane is the one whose tty is the Claude's stdin, which
 * holds however Claude was started there.
 */

/** The running Claudes: each one's pid and the short id of the session it's on now. */
export function runningClaudes(configDir: string): { pid: number; session: string }[] {
    const dir = path.join(configDir, 'sessions');
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`tsk: ${dir}: ${e}`);
        return [];
    }
    const running: { pid: number; session: string }[] = [];
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
                running.push({ pid: Number(pid), session: shortSessionId(file.sessionId) });
        } catch {
            // Claude rewrites it as its state changes: one caught mid-write is left out.
        }
    }
    return running;
}

/** The running Claudes' pids, by the short session id each is on now. */
export function runningSessions(configDir: string): Map<string, number> {
    return new Map(runningClaudes(configDir).map((c) => [c.session, c.pid]));
}

/** Runs tmux against the server the TUI is in; resolves to what it printed. */
export type Tmux = (args: readonly string[]) => Promise<string>;

/** tmux answers at once; one that doesn't isn't worth holding the key or the click for. */
export const TMUX_TIMEOUT_MS = 1000;
const run = promisify(execFile);

/** Why a tmux run failed: its own message, or that it didn't answer in time. */
export function tmuxError(e: unknown): string {
    const err = e as { stderr?: string; killed?: boolean; message?: string };
    if (err.killed) return `tmux didn't answer within ${TMUX_TIMEOUT_MS / 1000} s`;
    return `tmux: ${err.stderr?.trim() || err.message}`;
}

export interface SwitchIo {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly tmux?: Tmux;
    /** The terminal a process reads its keys from; undefined when it's gone. */
    readonly ttyOf?: (pid: number) => string | undefined;
}

/** The terminal process `pid` reads its keys from (its stdin); undefined when it's gone. */
export const ttyOfPid = (pid: number) => {
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
        return tmuxError(e);
    }
}
