import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { processStart } from './process-start';

/**
 * Asking a running `tsk tui` to select a task. Each TUI
 * listens on a Unix socket in a directory only the user can open, beside a
 * record of what it shows; an asker reads the records, picks the TUIs it
 * means, and sends each one line. Claude Code's inbox is found the same way
 * (`/tmp/cc-socks/<pid>.sock`, named in `sessions/<pid>.json`). One JSON line
 * each way over `node:net`: framing that small needs no library.
 */

/** What a TUI writes beside its socket; it doesn't change while the TUI runs. */
export interface TuiRecord {
    readonly pid: number;
    /** The TUI's start (`processStart`): a pid reused by another process isn't this TUI. */
    readonly procStart?: string;
    /** The `.tsk` file it shows, as a real path. */
    readonly file: string;
    /** The Claude Code process it follows; the session it shows is read from that Claude. */
    readonly followPid?: number;
    /** The session it's pinned to, when it follows none. */
    readonly session?: string;
    /** Its tmux pane, and the server's socket, when it runs in tmux. */
    readonly tmux?: TmuxPane;
}

export interface TmuxPane {
    readonly socket: string;
    /** `%<n>`: a pane keeps its id when it moves to another window. */
    readonly pane: string;
}

/** The pane a process runs in, from the `TMUX` (`<socket>,<server pid>,<session>`) and `TMUX_PANE` tmux gives it. */
export function tmuxOf(env: Readonly<Record<string, string | undefined>>): TmuxPane | undefined {
    const socket = /^(.+),\d+,\d+$/.exec(env.TMUX ?? '')?.[1];
    const pane = env.TMUX_PANE;
    return socket && pane && /^%\d+$/.test(pane) ? { socket, pane } : undefined;
}

export type SelectReply = { readonly ok: true } | { readonly ok: false; readonly why: string };

/** A request longer than this, with no end of line yet, is refused unread. */
export const MAX_REQUEST = 4096;
/** How long an asker waits for a TUI to answer. */
export const ASK_TIMEOUT_MS = 2000;
/** The characters a `tsk:<id>` ref takes, and no more of them than an id needs. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `TSK_RUNTIME_DIR`, else `<tmpdir>/tsk-<uid>`. */
export function runtimeDir(env: Readonly<Record<string, string | undefined>>): string {
    return (
        env.TSK_RUNTIME_DIR ||
        path.join(os.tmpdir(), `tsk-${process.getuid?.() ?? os.userInfo().username}`)
    );
}

/**
 * Throws unless `dir` is a directory of this user's that no one else can
 * open: in a shared `/tmp`, anyone could have made it first, to read the
 * requests or answer them.
 */
export function checkRuntimeDir(dir: string): void {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) throw new Error(`${dir} isn't a directory`);
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} belongs to another user`);
    if ((st.mode & 0o077) !== 0) {
        throw new Error(`${dir} is open to other users (chmod 700 it)`);
    }
}

/** Make `dir` (only the user can open it), or check the one there. */
export function makeRuntimeDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    checkRuntimeDir(dir);
}

export const socketPath = (dir: string, pid: number) => path.join(dir, `${pid}.sock`);
export const recordPath = (dir: string, pid: number) => path.join(dir, `${pid}.json`);

/** Every well-formed record in `dir`, live or not; none when there's no `dir`. */
export function readRecords(dir: string): TuiRecord[] {
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return names.flatMap((name) => {
        const pid = /^(\d+)\.json$/.exec(name)?.[1];
        if (!pid) return [];
        try {
            const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as TuiRecord;
            return r.pid === Number(pid) && typeof r.file === 'string' ? [r] : [];
        } catch {
            // Gone since the listing, or not one of ours: records are renamed into place whole.
            return [];
        }
    });
}

/** Whether the TUI that wrote `r` is still running. */
export function isAlive(r: TuiRecord): boolean {
    if (r.procStart !== undefined) return processStart(r.pid) === r.procStart;
    try {
        process.kill(r.pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

export const requestLine = (id: string) => `${JSON.stringify({ select: id })}\n`;
export const replyLine = (r: SelectReply) => `${JSON.stringify(r)}\n`;

export function parseRequest(line: string): { id: string } | { why: string } {
    let req: unknown;
    try {
        req = JSON.parse(line);
    } catch {
        return { why: 'not a request tsk can read' };
    }
    const id = (req as { select?: unknown } | null)?.select;
    if (typeof id !== 'string') return { why: 'not a request tsk can read' };
    return ID.test(id) ? { id } : { why: 'not a task id' };
}

export function parseReply(line: string): SelectReply {
    try {
        const r = JSON.parse(line) as { ok?: unknown; why?: unknown };
        if (r.ok === true) return { ok: true };
        if (r.ok === false && typeof r.why === 'string') return { ok: false, why: r.why };
    } catch {
        // Falls through to the answer below.
    }
    return { ok: false, why: "an answer tsk can't read" };
}

/** Ask the TUI with `pid` to select task `id`; rejects when it can't be reached or doesn't answer. */
export function askTui(
    dir: string,
    pid: number,
    id: string,
    timeoutMs = ASK_TIMEOUT_MS,
): Promise<SelectReply> {
    return new Promise((resolve, reject) => {
        const conn = net.connect(socketPath(dir, pid));
        let got = '';
        const timer = setTimeout(
            () => conn.destroy(new Error(`no answer within ${timeoutMs} ms`)),
            timeoutMs,
        );
        conn.setEncoding('utf8');
        conn.on('connect', () => conn.write(requestLine(id)));
        conn.on('data', (chunk: string) => {
            got += chunk;
            const end = got.indexOf('\n');
            if (end < 0) return;
            clearTimeout(timer);
            conn.end();
            resolve(parseReply(got.slice(0, end)));
        });
        conn.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
        // A no-op once the answer has resolved it.
        conn.on('close', () => {
            clearTimeout(timer);
            reject(new Error('it closed without answering'));
        });
    });
}

/** Who's asking `tsk show <id> --tui`. */
export interface Asker {
    /** The `.tsk` file, as a real path. */
    readonly file: string;
    /** `CLAUDE_PID`: asked from that Claude's shell. */
    readonly claudePid?: number;
    readonly session?: string;
}

/** A TUI for a message: its pid, and what it shows. */
export function describeTui(r: TuiRecord, session: string | undefined): string {
    const shows = [
        r.followPid !== undefined ? `following Claude ${r.followPid}` : undefined,
        session ? `session ${session}` : undefined,
    ].filter(Boolean);
    return shows.length > 0 ? `pid ${r.pid} (${shows.join(', ')})` : `pid ${r.pid}`;
}

/**
 * Which live TUIs `tsk show <id> --tui` asks: only ones on the asker's file.
 * From a Claude's shell, the one following that Claude and no other, so one
 * Claude can't move another's pane; else the ones showing the asker's
 * session; else the only one. `sessionOf` reads the session a TUI shows.
 */
export function pickTuis(
    live: readonly TuiRecord[],
    asker: Asker,
    sessionOf: (r: TuiRecord) => string | undefined,
): { tuis: TuiRecord[] } | { why: string } {
    const name = path.basename(asker.file);
    const onFile = live.filter((r) => r.file === asker.file);
    if (onFile.length === 0) return { why: `no TUI is open on ${name} — tsk tui opens one` };
    if (asker.claudePid !== undefined) {
        const tuis = onFile.filter((r) => r.followPid === asker.claudePid);
        if (tuis.length > 0) return { tuis };
        return {
            why: `no TUI on ${name} follows this Claude (pid ${asker.claudePid}) — tsk tui opens one`,
        };
    }
    if (asker.session !== undefined) {
        const tuis = onFile.filter((r) => sessionOf(r) === asker.session);
        if (tuis.length > 0) return { tuis };
        return { why: `no TUI on ${name} shows session ${asker.session}` };
    }
    if (onFile.length === 1) return { tuis: onFile };
    const which = onFile.map((r) => describeTui(r, sessionOf(r))).join('; ');
    return { why: `more than one TUI is open on ${name}; pick one with --session: ${which}` };
}

/** What one tmux server shows: each client's window, and each pane's. */
export interface TmuxView {
    /** Client pid → the window it shows. */
    readonly clients: ReadonlyMap<number, string>;
    /** Pane id → its window. */
    readonly panes: ReadonlyMap<string, string>;
}

/** `#{client_pid} #{window_id}` and `#{pane_id} #{window_id}` lines, as tmux lists them. */
export function parseTmuxView(clients: string, panes: string): TmuxView {
    const pairs = (out: string) =>
        out.split('\n').flatMap((l) => {
            const [a, b] = l.trim().split(' ');
            return a && b ? [[a, b] as const] : [];
        });
    return {
        clients: new Map(pairs(clients).map(([pid, w]) => [Number(pid), w])),
        panes: new Map(pairs(panes)),
    };
}

/**
 * The TUIs beside a terminal a link was clicked in, `under` being the
 * terminal's process and everything under it: the ones in a window that a
 * tmux client among them shows, and outside tmux, the ones following a
 * Claude that runs there, or running there themselves. `views` holds each
 * tmux server a TUI is on, by socket.
 */
export function tuisBeside(
    live: readonly TuiRecord[],
    under: ReadonlySet<number>,
    views: ReadonlyMap<string, TmuxView>,
): TuiRecord[] {
    const shown = new Map<string, Set<string>>();
    for (const [socket, view] of views) {
        const windows = [...view.clients].filter(([pid]) => under.has(pid)).map(([, w]) => w);
        if (windows.length > 0) shown.set(socket, new Set(windows));
    }
    const inShownWindow = (t: TmuxPane) => {
        const window = views.get(t.socket)?.panes.get(t.pane);
        return window !== undefined && shown.get(t.socket)?.has(window) === true;
    };
    return live.filter(
        (r) =>
            under.has(r.pid) ||
            (r.followPid !== undefined && under.has(r.followPid)) ||
            (r.tmux !== undefined && inShownWindow(r.tmux)),
    );
}
