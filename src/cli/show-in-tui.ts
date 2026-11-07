import fs from 'node:fs';
import type { TreeNode } from '../lib/task-tree';
import {
    askTui,
    describeTui,
    liveRecords,
    pickTuis,
    runtimeDir,
    type TuiRecord,
} from '../lib/tui-channel';
import { claudeConfigDir, followPid } from '../tui/follow';
import { label } from './format';

export interface ShowInTuiIo {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
}

/**
 * `tsk show <id> --tui`: select the task in the running TUIs `pickTuis`
 * means, instead of printing it. 0 when every one of them selected it.
 */
export async function showInTui(
    id: string,
    node: TreeNode,
    file: string,
    session: string | undefined,
    io: ShowInTuiIo,
): Promise<number> {
    const dir = runtimeDir(io.env);
    let live: TuiRecord[];
    try {
        live = liveRecords(dir);
    } catch (e) {
        io.err(`tsk: won't ask the TUIs: ${(e as Error).message}`);
        return 1;
    }
    const configDir = claudeConfigDir(io.env);
    const sessionOf = (r: TuiRecord) =>
        r.session ??
        (r.followPid !== undefined ? followPid(r.followPid, configDir).session : undefined);
    const claudePid = io.env.CLAUDE_PID ? Number(io.env.CLAUDE_PID) : undefined;
    const picked = pickTuis(
        live,
        {
            file: fs.realpathSync(file),
            claudePid: Number.isInteger(claudePid) ? claudePid : undefined,
            session,
        },
        sessionOf,
    );
    if ('why' in picked) {
        io.err(`tsk: ${picked.why}`);
        return 1;
    }
    let code = 0;
    for (const r of picked.tuis) {
        const which = `the TUI ${describeTui(r, sessionOf(r))}`;
        const reply = await askTui(dir, r.pid, id).catch((e: Error) => ({
            ok: false as const,
            why: e.message,
        }));
        if (reply.ok) io.out(`selected  ${label(node)}  in ${which}`);
        else {
            io.err(`tsk: ${which} didn't select ${id}: ${reply.why}`);
            code = 1;
        }
    }
    return code;
}
