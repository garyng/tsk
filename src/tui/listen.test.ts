import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processStart } from '../lib/process-start';
import { askTui, readRecords, recordPath, type SelectReply, socketPath } from '../lib/tui-channel';
import { listenForRequests } from './listen';

let root: string;
let dir: string;
let stop: (() => void) | undefined;
const errors: Error[] = [];
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsk-listen-'));
    dir = path.join(root, 'rt');
    errors.length = 0;
});
afterEach(() => {
    stop?.();
    stop = undefined;
    fs.rmSync(root, { recursive: true, force: true });
});

const shows = {
    file: '/w/claude.tsk',
    followPid: 10,
    tmux: { socket: '/tmp/tmux-1/default', pane: '%4' },
};
const listen = async (onSelect: (id: string) => SelectReply = () => ({ ok: true })) => {
    stop = await listenForRequests({ dir, shows, onSelect, onError: (e) => errors.push(e) });
};
/** Send `text` as it is and read the answer. */
const raw = (text: string) =>
    new Promise<string>((resolve, reject) => {
        const conn = net.connect(socketPath(dir, process.pid));
        let got = '';
        conn.setEncoding('utf8');
        conn.on('connect', () => conn.write(text));
        conn.on('data', (chunk: string) => {
            got += chunk;
        });
        conn.on('close', () => resolve(got));
        conn.on('error', reject);
    });

describe('listenForRequests', () => {
    it('makes its directory, then listens beside a record of what it shows', async () => {
        await listen();
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(socketPath(dir, process.pid)).isSocket()).toBe(true);
        expect(readRecords(dir)).toEqual([
            { pid: process.pid, procStart: processStart(process.pid), ...shows },
        ]);
        expect(fs.readdirSync(dir).sort()).toEqual([`${process.pid}.json`, `${process.pid}.sock`]);
    });

    it("answers each request with onSelect's reply", async () => {
        const asked: string[] = [];
        await listen((id) => {
            asked.push(id);
            return id === 'ab12cd34' ? { ok: true } : { ok: false, why: `no task ${id}` };
        });
        await expect(askTui(dir, process.pid, 'ab12cd34')).resolves.toEqual({ ok: true });
        await expect(askTui(dir, process.pid, 'zz')).resolves.toEqual({
            ok: false,
            why: 'no task zz',
        });
        expect(asked).toEqual(['ab12cd34', 'zz']);
    });

    it("refuses what isn't a request, a long one, and a bad id, without asking the app", async () => {
        const asked: string[] = [];
        await listen((id) => {
            asked.push(id);
            return { ok: true };
        });
        expect(await raw('hello\n')).toBe('{"ok":false,"why":"not a request tsk can read"}\n');
        expect(await raw('{"select":"a/b"}\n')).toBe('{"ok":false,"why":"not a task id"}\n');
        expect(await raw('x'.repeat(5000))).toBe('{"ok":false,"why":"request too long"}\n');
        expect(asked).toEqual([]);
    });

    it('answers a failure in the app, and reports it', async () => {
        await listen(() => {
            throw new Error('boom');
        });
        await expect(askTui(dir, process.pid, 'a')).resolves.toEqual({
            ok: false,
            why: 'the TUI failed: boom',
        });
        expect(errors.map((e) => e.message)).toEqual(['boom']);
    });

    it("removes a dead TUI's leftovers on the way in, and leaves a live one's", async () => {
        fs.mkdirSync(dir, { mode: 0o700 });
        const dead = { pid: process.pid + 1, procStart: '1', file: '/w/claude.tsk' };
        fs.writeFileSync(recordPath(dir, dead.pid), JSON.stringify(dead));
        fs.writeFileSync(socketPath(dir, dead.pid), '');
        const live = {
            pid: process.ppid,
            procStart: processStart(process.ppid),
            file: '/w/claude.tsk',
        };
        fs.writeFileSync(recordPath(dir, live.pid), JSON.stringify(live));
        await listen();
        expect(fs.existsSync(recordPath(dir, dead.pid))).toBe(false);
        expect(fs.existsSync(socketPath(dir, dead.pid))).toBe(false);
        expect(fs.existsSync(recordPath(dir, live.pid))).toBe(true);
    });

    it('takes over a socket left at its own pid', async () => {
        fs.mkdirSync(dir, { mode: 0o700 });
        fs.writeFileSync(socketPath(dir, process.pid), '');
        await listen();
        await expect(askTui(dir, process.pid, 'a')).resolves.toEqual({ ok: true });
    });

    it('stopping removes the socket and the record', async () => {
        await listen();
        stop?.();
        stop = undefined;
        expect(fs.readdirSync(dir)).toEqual([]);
        await expect(askTui(dir, process.pid, 'a')).rejects.toThrow(/ENOENT/);
    });

    it('refuses a directory others can open', async () => {
        fs.mkdirSync(dir, { mode: 0o755 });
        fs.chmodSync(dir, 0o755);
        await expect(listen()).rejects.toThrow(/open to other users/);
        expect(fs.readdirSync(dir)).toEqual([]);
    });
});
