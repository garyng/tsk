import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processStart } from './process-start';
import {
    askTui,
    checkRuntimeDir,
    describeTui,
    isAlive,
    makeRuntimeDir,
    parseReply,
    parseRequest,
    parseTmuxView,
    pickTuis,
    readRecords,
    recordPath,
    requestLine,
    runtimeDir,
    socketPath,
    type TuiRecord,
    tmuxOf,
    tuisBeside,
} from './tui-channel';

let dir: string;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsk-channel-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const me: TuiRecord = {
    pid: process.pid,
    procStart: processStart(process.pid),
    file: '/w/claude.tsk',
};

describe('the runtime directory', () => {
    it('is TSK_RUNTIME_DIR when set, else one per user in the temp directory', () => {
        expect(runtimeDir({ TSK_RUNTIME_DIR: '/x/y' })).toBe('/x/y');
        expect(runtimeDir({})).toBe(path.join(os.tmpdir(), `tsk-${process.getuid?.()}`));
    });

    it('is made for the user alone', () => {
        const made = path.join(dir, 'a', 'b');
        makeRuntimeDir(made);
        expect(fs.statSync(made).mode & 0o777).toBe(0o700);
    });

    it('is refused when others can open it, or it is not a directory', () => {
        fs.chmodSync(dir, 0o755);
        expect(() => checkRuntimeDir(dir)).toThrow(/open to other users \(chmod 700 it\)/);
        const file = path.join(dir, 'f');
        fs.writeFileSync(file, '');
        expect(() => checkRuntimeDir(file)).toThrow(/isn't a directory/);
        const link = path.join(dir, 'link');
        const real = path.join(dir, 'real');
        fs.mkdirSync(real, { mode: 0o700 });
        fs.symlinkSync(real, link);
        expect(() => checkRuntimeDir(link)).toThrow(/isn't a directory/);
    });
});

describe('records', () => {
    it("reads each well-formed record, and skips what isn't one", () => {
        fs.writeFileSync(
            recordPath(dir, 41),
            JSON.stringify({ pid: 41, file: '/w/a.tsk', followPid: 7 }),
        );
        fs.writeFileSync(recordPath(dir, 42), '{ half a rec');
        fs.writeFileSync(recordPath(dir, 43), JSON.stringify({ pid: 99, file: '/w/a.tsk' }));
        fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ pid: 1, file: '/w' }));
        fs.writeFileSync(socketPath(dir, 41), '');
        expect(readRecords(dir)).toEqual([{ pid: 41, file: '/w/a.tsk', followPid: 7 }]);
        expect(readRecords(path.join(dir, 'none'))).toEqual([]);
    });

    it('are live while the process that wrote them runs, and not once its pid is reused', () => {
        expect(isAlive(me)).toBe(true);
        expect(isAlive({ ...me, procStart: '1' })).toBe(false);
        expect(isAlive({ pid: 2 ** 22 + 1, procStart: '1', file: '/w' })).toBe(false);
    });
});

describe('the lines', () => {
    it('a request names one task id', () => {
        expect(requestLine('ab12cd34')).toBe('{"select":"ab12cd34"}\n');
        expect(parseRequest('{"select":"ab12cd34"}')).toEqual({ id: 'ab12cd34' });
        expect(parseRequest('{"select":"../../etc"}')).toEqual({ why: 'not a task id' });
        expect(parseRequest(`{"select":"${'a'.repeat(65)}"}`)).toEqual({ why: 'not a task id' });
        expect(parseRequest('{"select":3}')).toEqual({ why: 'not a request tsk can read' });
        expect(parseRequest('null')).toEqual({ why: 'not a request tsk can read' });
        expect(parseRequest('select ab')).toEqual({ why: 'not a request tsk can read' });
    });

    it('a reply is ok, or why not', () => {
        expect(parseReply('{"ok":true}')).toEqual({ ok: true });
        expect(parseReply('{"ok":false,"why":"busy"}')).toEqual({ ok: false, why: 'busy' });
        expect(parseReply('{"ok":"yes"}')).toEqual({ ok: false, why: "an answer tsk can't read" });
        expect(parseReply('garbage')).toEqual({ ok: false, why: "an answer tsk can't read" });
    });
});

describe('askTui', () => {
    /** A stand-in TUI at `pid`'s socket, answering each request with `answer(line)`. */
    async function standIn(pid: number, answer: (line: string) => string | undefined) {
        const seen: string[] = [];
        const server = net.createServer((conn) => {
            conn.setEncoding('utf8');
            conn.on('data', (line: string) => {
                seen.push(line);
                const reply = answer(line);
                if (reply !== undefined) conn.end(reply);
            });
        });
        await new Promise<void>((resolve) => server.listen(socketPath(dir, pid), resolve));
        return { seen, close: () => new Promise((resolve) => server.close(resolve)) };
    }

    it('sends the request and resolves to the answer', async () => {
        const tui = await standIn(1, () => '{"ok":false,"why":"busy: a note is being typed"}\n');
        await expect(askTui(dir, 1, 'ab12cd34')).resolves.toEqual({
            ok: false,
            why: 'busy: a note is being typed',
        });
        expect(tui.seen).toEqual(['{"select":"ab12cd34"}\n']);
        await tui.close();
    });

    it("rejects when nothing listens, it hangs up without answering, or it doesn't answer in time", async () => {
        await expect(askTui(dir, 2, 'a')).rejects.toThrow(/ENOENT/);
        const hangsUp = await standIn(3, () => '');
        await expect(askTui(dir, 3, 'a')).rejects.toThrow('it closed without answering');
        await hangsUp.close();
        const silent = await standIn(4, () => undefined);
        await expect(askTui(dir, 4, 'a', 50)).rejects.toThrow('no answer within 50 ms');
        await silent.close();
    });
});

describe('pickTuis', () => {
    const file = '/w/claude.tsk';
    const following = (pid: number, followPid: number): TuiRecord => ({ pid, file, followPid });
    const sessions: Record<number, string> = { 10: 'aaaaaaaa', 11: 'bbbbbbbb' };
    const sessionOf = (r: TuiRecord) =>
        r.session ?? (r.followPid !== undefined ? sessions[r.followPid] : undefined);
    const a = following(1, 10);
    const b = following(2, 11);
    const elsewhere: TuiRecord = { pid: 3, file: '/w/other.tsk', followPid: 10 };
    const pinned: TuiRecord = { pid: 4, file, session: 'bbbbbbbb' };

    it("asks only TUIs on the asker's file", () => {
        expect(pickTuis([elsewhere], { file }, sessionOf)).toEqual({
            why: 'no TUI is open on claude.tsk; `tsk tui` opens one',
        });
        expect(pickTuis([elsewhere], { file, claudePid: 10 }, sessionOf)).toEqual({
            why: 'no TUI is open on claude.tsk; `tsk tui --follow-pid 10` opens one',
        });
    });

    it("from a Claude's shell, asks the one following that Claude and no other", () => {
        expect(pickTuis([a, b, elsewhere], { file, claudePid: 10 }, sessionOf)).toEqual({
            tuis: [a],
        });
        expect(pickTuis([b], { file, claudePid: 10, session: 'bbbbbbbb' }, sessionOf)).toEqual({
            why: 'no TUI on claude.tsk follows this Claude (pid 10); `tsk tui --follow-pid 10` opens one',
        });
    });

    it('with a session, asks the ones showing it, following or pinned', () => {
        expect(pickTuis([a, b, pinned], { file, session: 'bbbbbbbb' }, sessionOf)).toEqual({
            tuis: [b, pinned],
        });
        expect(pickTuis([a], { file, session: 'cccccccc' }, sessionOf)).toEqual({
            why: 'no TUI on claude.tsk shows session cccccccc',
        });
    });

    it('otherwise asks the only one, and with more refuses, naming them', () => {
        expect(pickTuis([a, elsewhere], { file }, sessionOf)).toEqual({ tuis: [a] });
        expect(pickTuis([a, pinned], { file }, sessionOf)).toEqual({
            why: 'more than one TUI is open on claude.tsk; pick one with --session: pid 1 (following Claude 10, session aaaaaaaa); pid 4 (session bbbbbbbb)',
        });
    });

    it('describes a TUI by what it shows', () => {
        expect(describeTui({ pid: 5, file }, undefined)).toBe('pid 5');
        expect(describeTui(a, undefined)).toBe('pid 1 (following Claude 10)');
    });
});

describe('tmux', () => {
    it("reads a process's pane from the environment tmux gives it", () => {
        expect(tmuxOf({ TMUX: '/tmp/tmux-1000/default,84773,0', TMUX_PANE: '%4' })).toEqual({
            socket: '/tmp/tmux-1000/default',
            pane: '%4',
        });
        expect(tmuxOf({ TMUX: '/tmp/a,b/sock,1,2', TMUX_PANE: '%10' })?.socket).toBe(
            '/tmp/a,b/sock',
        );
        expect(tmuxOf({})).toBeUndefined();
        expect(tmuxOf({ TMUX: '/tmp/tmux-1000/default,84773,0' })).toBeUndefined();
        expect(tmuxOf({ TMUX: 'garbage', TMUX_PANE: '%4' })).toBeUndefined();
    });

    it('parses what a server lists', () => {
        const view = parseTmuxView('365034 @2\n', '%7 @2\n%0 @0\n%5 @0\n\n');
        expect(view.clients).toEqual(new Map([[365034, '@2']]));
        expect(view.panes).toEqual(
            new Map([
                ['%7', '@2'],
                ['%0', '@0'],
                ['%5', '@0'],
            ]),
        );
    });
});

describe('tuisBeside', () => {
    const file = '/w/claude.tsk';
    const sock = '/tmp/tmux-1000/default';
    // Two windows: Claude 100 beside TUI 1 in @0, Claude 200 beside TUI 2 in @1.
    const one: TuiRecord = { pid: 1, file, followPid: 100, tmux: { socket: sock, pane: '%1' } };
    const two: TuiRecord = { pid: 2, file, followPid: 200, tmux: { socket: sock, pane: '%3' } };
    const views = new Map([
        [sock, parseTmuxView('50 @1\n60 @0\n', '%0 @0\n%1 @0\n%2 @1\n%3 @1\n')],
    ]);

    it('asks the TUIs in the window the clicked tmux client shows', () => {
        // The terminal runs a shell (40) that runs tmux client 50, which shows @1.
        expect(tuisBeside([one, two], new Set([40, 50]), views)).toEqual([two]);
        expect(tuisBeside([one, two], new Set([60]), views)).toEqual([one]);
    });

    it("leaves a TUI on another server, or in a window no client of the terminal's shows, alone", () => {
        const elsewhere = { ...two, tmux: { socket: '/tmp/tmux-1000/other', pane: '%3' } };
        expect(tuisBeside([elsewhere], new Set([50]), views)).toEqual([]);
        expect(tuisBeside([one, two], new Set([70]), views)).toEqual([]);
    });

    it('outside tmux, asks the TUIs following a Claude in the terminal, or running there', () => {
        const plain: TuiRecord = { pid: 3, file, followPid: 300 };
        const own: TuiRecord = { pid: 4, file };
        expect(tuisBeside([plain, own], new Set([299, 300]), new Map())).toEqual([plain]);
        expect(tuisBeside([plain, own], new Set([4]), new Map())).toEqual([own]);
    });
});
