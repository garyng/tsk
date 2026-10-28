import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processStart } from '../lib/process-start';
import { shortSessionId } from '../lib/session-focus';

/**
 * Which session a running Claude Code process is on *now*. Each live Claude
 * keeps `<config>/sessions/<pid>.json`; `/branch` and `/clear` rewrite its
 * `sessionId` in place, so re-reading it is how a side pane follows the
 * conversation.
 * The file's format is internal to Claude Code: only `sessionId`, `status`,
 * `procStart` and `messagingSocketPath` are read, and a file that doesn't
 * parse reads as "unknown".
 */

export interface Followed {
    readonly session: string | undefined;
    /** The whole session id, which names its transcript. */
    readonly sessionId?: string;
    /** Its cross-session inbox socket (Claude Code 2.1.224+), which `S` posts to. */
    readonly socket?: string;
    /** `idle` / `busy` / `waiting` / …, or why there's nothing to show. */
    readonly status: string;
    readonly alive: boolean;
}

export function claudeConfigDir(env: Readonly<Record<string, string | undefined>>): string {
    return env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

export function followPid(pid: number, configDir: string): Followed {
    let file: {
        sessionId?: string;
        status?: string;
        procStart?: string | number;
        messagingSocketPath?: string;
    };
    try {
        file = JSON.parse(fs.readFileSync(path.join(configDir, 'sessions', `${pid}.json`), 'utf8'));
    } catch (e) {
        const why =
            (e as NodeJS.ErrnoException).code === 'ENOENT'
                ? 'no such Claude'
                : 'unreadable session file';
        return { session: undefined, status: why, alive: false };
    }
    const session = file.sessionId ? shortSessionId(file.sessionId) : undefined;
    // A session file outlives its Claude, and a pid can be reused: alive only if the
    // process that holds the pid started when the file says it did.
    const alive = file.procStart === undefined || String(file.procStart) === processStart(pid);
    return {
        session,
        sessionId: file.sessionId,
        socket: file.messagingSocketPath,
        status: alive ? (file.status ?? 'running') : 'Claude exited',
        alive,
    };
}
