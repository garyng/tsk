import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { followPid } from './follow';

let config: string;
const pid = process.pid;
/** This test process's own start time, as Claude Code records it. */
const myStart = () => {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
};
const writeSession = (body: object) =>
    fs.writeFileSync(path.join(config, 'sessions', `${pid}.json`), JSON.stringify(body));

beforeEach(() => {
    config = fs.mkdtempSync(path.join(os.tmpdir(), 'tsk-follow-'));
    fs.mkdirSync(path.join(config, 'sessions'));
});
afterEach(() => fs.rmSync(config, { recursive: true, force: true }));

describe('followPid', () => {
    it("reads the live process's current session and status", () => {
        writeSession({
            sessionId: 'abcdef12-3456',
            status: 'busy',
            procStart: myStart(),
            messagingSocketPath: '/tmp/cc-socks/1.sock',
        });
        expect(followPid(pid, config)).toEqual({
            session: 'abcdef12',
            sessionId: 'abcdef12-3456',
            socket: '/tmp/cc-socks/1.sock',
            status: 'busy',
            alive: true,
        });
    });

    it('follows the session id when /clear or /branch rewrites the file', () => {
        writeSession({ sessionId: 'aaaaaaaa-1', procStart: myStart() });
        expect(followPid(pid, config).session).toBe('aaaaaaaa');
        writeSession({ sessionId: 'bbbbbbbb-2', procStart: myStart() });
        expect(followPid(pid, config).session).toBe('bbbbbbbb');
    });

    it('treats a reused pid as an exited Claude, keeping the last session', () => {
        writeSession({ sessionId: 'abcdef12-3456', status: 'idle', procStart: '1' });
        expect(followPid(pid, config)).toEqual({
            session: 'abcdef12',
            sessionId: 'abcdef12-3456',
            status: 'Claude exited',
            alive: false,
        });
    });

    it('says when there is no such Claude', () => {
        expect(followPid(999_999_999, config)).toEqual({
            session: undefined,
            status: 'no such Claude',
            alive: false,
        });
    });
});
