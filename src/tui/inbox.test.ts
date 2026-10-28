import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Delivery } from '../lib/tui-ask';
import { inboxLine, postToInbox, readNewLines, tellSession, transcriptPath } from './inbox';

let dir: string;
let server: net.Server | undefined;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsk-inbox-'));
});
afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for a session's inbox: collects what each connection sent, answering nothing. */
async function inbox(): Promise<{ socket: string; received: string[] }> {
    const socket = path.join(dir, 'inbox.sock');
    const received: string[] = [];
    server = net.createServer((conn) => {
        let got = '';
        conn.on('data', (d) => {
            got += d.toString();
        });
        conn.on('end', () => {
            received.push(got);
            conn.end();
        });
    });
    await new Promise<void>((r) => server?.listen(socket, r));
    return { socket, received };
}

const until = async (check: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

describe('inboxLine', () => {
    it('is the stream-json user message, its content a string, on one line', () => {
        expect(inboxLine('hi "there"')).toBe(
            '{"type":"user","message":{"role":"user","content":"hi \\"there\\""}}\n',
        );
    });
});

describe('postToInbox', () => {
    it('sends the one line and closes', async () => {
        const box = await inbox();
        await postToInbox(box.socket, 'pick it up');
        await until(() => box.received.length > 0);
        expect(box.received).toEqual([inboxLine('pick it up')]);
    });
    it("rejects when there's no socket", async () => {
        await expect(postToInbox(path.join(dir, 'none.sock'), 'x')).rejects.toThrow(/ENOENT/);
    });
});

describe('transcriptPath', () => {
    it("finds the session's file under any project directory", () => {
        fs.mkdirSync(path.join(dir, 'projects', '-a'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'projects', '-b'));
        fs.writeFileSync(path.join(dir, 'projects', '-b', 'sid.jsonl'), '');
        expect(transcriptPath(dir, 'sid')).toBe(path.join(dir, 'projects', '-b', 'sid.jsonl'));
        expect(transcriptPath(dir, 'other')).toBeUndefined();
        expect(transcriptPath(path.join(dir, 'nope'), 'sid')).toBeUndefined();
    });
});

describe('readNewLines', () => {
    it('reads whole lines after an offset, leaving a line still being written for next time', () => {
        const file = path.join(dir, 't.jsonl');
        fs.writeFileSync(file, 'old\n');
        fs.appendFileSync(file, 'one\ntwo\nthr');
        const first = readNewLines(file, 4);
        expect(first.lines).toEqual(['one', 'two']);
        fs.appendFileSync(file, 'ee\n');
        expect(readNewLines(file, first.end)).toEqual({ lines: ['three'], end: 18 });
        expect(readNewLines(file, 18).lines).toEqual([]);
        expect(readNewLines(path.join(dir, 'none'), 3)).toEqual({ lines: [], end: 3 });
    });
});

describe('tellSession', () => {
    it("posts, then reports the session queueing and reading it from the transcript's new lines", async () => {
        const box = await inbox();
        const file = path.join(dir, 't.jsonl');
        // An earlier, identical message already in the transcript must not count.
        const enqueue = (content: string) =>
            `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content })}\n`;
        fs.writeFileSync(file, enqueue('go'));
        const seen: Delivery[] = [];
        const stop = await tellSession(
            { socket: box.socket, transcript: () => file, pid: 77, pollMs: 10 },
            'go',
            (d) => seen.push(d),
        );
        await until(() => box.received.length > 0);
        expect(box.received).toEqual([inboxLine('go')]);
        fs.appendFileSync(file, enqueue('go'));
        await until(() => seen.length === 1);
        const read = {
            type: 'user',
            origin: { verifiedPeerPid: 77 },
            message: { content: 'x\ngo\n' },
        };
        fs.appendFileSync(file, `${JSON.stringify(read)}\n${enqueue('go')}`);
        await until(() => seen.length >= 2);
        await new Promise((r) => setTimeout(r, 40));
        // Read ends the watch: the enqueue after it isn't reported.
        expect(seen).toEqual(['queued', 'read']);
        stop();
    });
    it("finds a transcript that didn't exist when it posted, and reads it from the start", async () => {
        const box = await inbox();
        const file = path.join(dir, 'late.jsonl');
        const seen: Delivery[] = [];
        let exists = false;
        const stop = await tellSession(
            {
                socket: box.socket,
                transcript: () => (exists ? file : undefined),
                pid: 77,
                pollMs: 10,
            },
            'go',
            (d) => seen.push(d),
        );
        fs.writeFileSync(
            file,
            `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'go' })}\n`,
        );
        exists = true;
        await until(() => seen.length > 0);
        expect(seen).toEqual(['queued']);
        stop();
    });
    it('rejects, and watches nothing, when the post fails', async () => {
        await expect(
            tellSession(
                {
                    socket: path.join(dir, 'none.sock'),
                    transcript: () => undefined,
                    pid: 1,
                    pollMs: 10,
                },
                'go',
                () => {},
            ),
        ).rejects.toThrow(/ENOENT/);
    });
});
