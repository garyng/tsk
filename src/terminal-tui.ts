import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type * as vscode from 'vscode';
import type { Logger } from './lib/logger';
import { processTree } from './lib/process-tree';
import {
    askTui,
    checkRuntimeDir,
    isAlive,
    parseTmuxView,
    readRecords,
    runtimeDir,
    type TmuxView,
    tuisBeside,
} from './lib/tui-channel';

const run = promisify(execFile);
/** tmux answers a listing at once; one that doesn't isn't worth holding the click for. */
const TMUX_TIMEOUT_MS = 1000;

async function tmuxView(socket: string, logger: Logger): Promise<TmuxView | undefined> {
    const list = (args: string[]) =>
        run('tmux', ['-S', socket, ...args], { timeout: TMUX_TIMEOUT_MS }).then((r) => r.stdout);
    try {
        const [clients, panes] = await Promise.all([
            list(['list-clients', '-F', '#{client_pid} #{window_id}']),
            list(['list-panes', '-a', '-F', '#{pane_id} #{window_id}']),
        ]);
        return parseTmuxView(clients, panes);
    } catch (e) {
        logger.warn(`tmux at ${socket}: ${(e as Error).message}`);
        return undefined;
    }
}

/**
 * After a click on `tsk:<id>` in `terminal`, select the task in the TUIs
 * beside it (`tuisBeside`) that show the task's file too:
 * Claude names a task, Ctrl+Click reveals it in the editor and in the pane next
 * to that Claude. Everything that goes wrong is logged, never shown: the reveal
 * in the editor has already happened.
 */
export async function selectInTuisBeside(
    terminal: vscode.Terminal | undefined,
    id: string,
    file: string,
    logger: Logger,
): Promise<void> {
    const dir = runtimeDir(process.env);
    if (!terminal || !fs.existsSync(dir)) return;
    try {
        checkRuntimeDir(dir);
    } catch (e) {
        logger.warn(`won't ask the TUIs: ${(e as Error).message}`);
        return;
    }
    let real: string;
    try {
        real = fs.realpathSync(file);
    } catch (e) {
        logger.warn(`tsk:${id}'s file: ${(e as Error).message}`);
        return;
    }
    const live = readRecords(dir).filter((r) => r.file === real && isAlive(r));
    const pid = await terminal.processId;
    if (live.length === 0 || pid === undefined) return;
    const sockets = [...new Set(live.flatMap((r) => (r.tmux ? [r.tmux.socket] : [])))];
    const views = new Map<string, TmuxView>();
    for (const socket of sockets) {
        const view = await tmuxView(socket, logger);
        if (view) views.set(socket, view);
    }
    const beside = tuisBeside(live, processTree(pid), views);
    if (beside.length === 0) logger.info(`tsk:${id}: no TUI beside the terminal (pid ${pid})`);
    for (const r of beside) {
        const reply = await askTui(dir, r.pid, id).catch((e: Error) => ({
            ok: false as const,
            why: e.message,
        }));
        if (reply.ok) logger.info(`tsk:${id} selected in the TUI pid ${r.pid}`);
        else logger.warn(`tsk:${id}: the TUI pid ${r.pid} didn't select it: ${reply.why}`);
    }
}
