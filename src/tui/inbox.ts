import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { type Delivery, deliveryOf } from '../lib/tui-ask';

/**
 * Posting to a running Claude Code session's cross-session inbox socket, and
 * reading its transcript for when the session has the message. The
 * socket answers nothing and can't take a message back, so the transcript is
 * the only receipt, and a withdrawal is another message.
 */

/**
 * The one line the socket takes: the SDK's stream-json user message, its
 * content a string — an array of blocks is dropped without a word. No auth
 * line: on Linux the socket checks the connecting process, not a token.
 */
export function inboxLine(text: string): string {
    return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
}

/** How long a connection may take to open and take the line. */
const POST_TIMEOUT_MS = 3000;
/** After the line is sent, how long to wait for the session to close its end before closing ours. */
const LINGER_MS = 1000;

/** Send `text` to the socket; resolves once the line has gone out. */
export function postToInbox(socket: string, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const conn = net.connect(socket);
        const timer = setTimeout(
            () => conn.destroy(new Error(`no answer from ${socket}`)),
            POST_TIMEOUT_MS,
        );
        conn.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
        conn.on('connect', () => {
            conn.end(inboxLine(text), () => {
                clearTimeout(timer);
                resolve();
                // The session reads to the end of the line, then closes; don't wait on it forever.
                setTimeout(() => conn.destroy(), LINGER_MS).unref();
            });
        });
    });
}

/** `<config>/projects/<the session's directory>/<sessionId>.jsonl`, found without knowing how Claude Code names the directory. */
export function transcriptPath(configDir: string, sessionId: string): string | undefined {
    const projects = path.join(configDir, 'projects');
    let dirs: string[];
    try {
        dirs = fs.readdirSync(projects);
    } catch {
        return undefined;
    }
    for (const dir of dirs) {
        const file = path.join(projects, dir, `${sessionId}.jsonl`);
        if (fs.existsSync(file)) return file;
    }
    return undefined;
}

/** The whole lines written to `file` after byte `from`, and where they end; a line still being written waits for the next read. */
export function readNewLines(file: string, from: number): { lines: string[]; end: number } {
    let fd: number;
    try {
        fd = fs.openSync(file, 'r');
    } catch {
        return { lines: [], end: from };
    }
    try {
        const size = fs.fstatSync(fd).size;
        if (size <= from) return { lines: [], end: from };
        const buf = Buffer.alloc(size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        const last = buf.lastIndexOf(10);
        if (last < 0) return { lines: [], end: from };
        return { lines: buf.subarray(0, last).toString('utf8').split('\n'), end: from + last + 1 };
    } finally {
        fs.closeSync(fd);
    }
}

const sizeOf = (file: string) => {
    try {
        return fs.statSync(file).size;
    } catch {
        return 0;
    }
};

export interface TellTarget {
    readonly socket: string;
    /** The session's transcript, when it has one yet. */
    transcript(): string | undefined;
    /** The posting process — this one — as the transcript's `verifiedPeerPid` will name it. */
    readonly pid: number;
    readonly pollMs: number;
}

/**
 * Post `text`, then read the transcript on from where it ended before the
 * post, calling `onDelivery` as the session queues and reads it (or drops
 * it). Rejects when the post fails; resolves to a function that stops
 * reading, which also stops by itself once the message is read or dropped.
 */
export async function tellSession(
    target: TellTarget,
    text: string,
    onDelivery: (d: Delivery) => void,
): Promise<() => void> {
    let file = target.transcript();
    // Measured before posting, so the session's first line about it can't be skipped.
    let at = file ? sizeOf(file) : 0;
    await postToInbox(target.socket, text);
    const timer = setInterval(() => {
        // A session's transcript can start with this very message (a fresh session, after /clear).
        file ??= target.transcript();
        if (!file) return;
        const read = readNewLines(file, at);
        at = read.end;
        for (const line of read.lines) {
            const d = deliveryOf(line, { text, pid: target.pid });
            if (!d) continue;
            onDelivery(d);
            if (d !== 'queued') {
                clearInterval(timer);
                return;
            }
        }
    }, target.pollMs);
    timer.unref();
    return () => clearInterval(timer);
}
