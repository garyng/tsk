import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processStart } from '../lib/process-start';
import { runningSessions, switchToClaude, type Tmux } from './claude-panes';

let config: string;
const write = (name: string, body: string) =>
    fs.writeFileSync(path.join(config, 'sessions', name), body);
const session = (pid: number, sessionId: string, procStart = processStart(pid)) =>
    write(`${pid}.json`, JSON.stringify({ pid, sessionId, procStart }));

beforeEach(() => {
    config = fs.mkdtempSync(path.join(os.tmpdir(), 'tsk-claude-panes-'));
    fs.mkdirSync(path.join(config, 'sessions'));
});
afterEach(() => fs.rmSync(config, { recursive: true, force: true }));

describe('runningSessions', () => {
    it('maps each running Claude by the session it is on, leaving out the rest', () => {
        session(process.pid, 'aaaa0001-2345-6789');
        // A pid reused since its Claude exited: the process started at another time.
        session(process.ppid, 'bbbb0001-2345', '1');
        // An exited Claude whose pid nothing holds.
        session(4_194_303, 'cccc0001-2345');
        write('1.json', '{"sessionId": "dddd0001'); // mid-write
        write('1018507.9f0acd.key', 'not a session');
        expect(runningSessions(config)).toEqual(new Map([['aaaa0001', process.pid]]));
    });

    it('is empty without the folder', () => {
        expect(runningSessions(path.join(config, 'nowhere'))).toEqual(new Map());
    });
});

describe('switchToClaude', () => {
    const env = { TMUX: '/tmp/tmux-1000/default,123,0' };
    const panes = '/dev/pts/3 %3\n/dev/pts/7 %12\n';
    const recorder = (fail?: Error) => {
        const calls: string[][] = [];
        const tmux: Tmux = async (args) => {
            calls.push([...args]);
            if (fail && args[0] === 'switch-client') throw fail;
            return args[0] === 'list-panes' ? panes : '';
        };
        return { calls, tmux };
    };

    it("switches the client to the pane on the Claude's terminal", async () => {
        const { calls, tmux } = recorder();
        expect(await switchToClaude(42, { env, tmux, ttyOf: () => '/dev/pts/7' })).toBeUndefined();
        expect(calls).toEqual([
            ['list-panes', '-a', '-F', '#{pane_tty} #{pane_id}'],
            ['switch-client', '-t', '%12'],
        ]);
    });

    it('says why when it can not', async () => {
        const { tmux } = recorder(
            Object.assign(new Error('failed'), { stderr: "can't find pane\n" }),
        );
        const ttyOf = () => '/dev/pts/7';
        expect(await switchToClaude(42, { env: {}, tmux, ttyOf })).toBe('not in tmux');
        expect(await switchToClaude(42, { env, tmux, ttyOf: () => undefined })).toBe(
            'its Claude has exited',
        );
        expect(await switchToClaude(42, { env, tmux, ttyOf: () => '/dev/pts/9' })).toBe(
            "its Claude isn't in a tmux pane",
        );
        expect(await switchToClaude(42, { env, tmux, ttyOf })).toBe("tmux: can't find pane");
    });
});
