import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openInVsCode, parseListeners, type VsCodeSystem } from './open-in-vscode';

const SERVER = '/srv/vscode-server/bin/abc';
const REMOTE_CLI = `${SERVER}/bin/remote-cli/code`;
const SHIM = 'code or code-insiders is not installed';

/** A system with these sockets (newest first) and listeners, recording each run. */
function fake(o: {
    sockets: string[];
    listeners?: Record<string, number>;
    noSs?: boolean;
    exes?: Record<number, string>;
    executables?: string[];
    /** Why a run fails, if it does. */
    fails?: (cli: string, sock: string | undefined) => string | undefined;
}) {
    const runs: { cli: string; sock: string | undefined }[] = [];
    const dirs: string[] = [];
    const sys: VsCodeSystem = {
        sockets: (dir) => {
            dirs.push(dir);
            return o.sockets;
        },
        listeners: async () => (o.noSs ? undefined : new Map(Object.entries(o.listeners ?? {}))),
        exeOf: (pid) => o.exes?.[pid],
        isExecutable: (file) => o.executables?.includes(file) ?? false,
        run: async (cli, _args, env) => {
            runs.push({ cli, sock: env.VSCODE_IPC_HOOK_CLI });
            return o.fails?.(cli, env.VSCODE_IPC_HOOK_CLI);
        },
    };
    return { sys, runs, dirs };
}
/** The base image's `code`: a shim that finds no real one on a tmux pane's PATH. */
const shimFails = (cli: string) => (cli === 'code' ? SHIM : undefined);

describe('openInVsCode', () => {
    it("from a pane VS Code didn't start: the remote CLI beside the live socket's server, on that socket", async () => {
        const f = fake({
            sockets: ['/tmp/vscode-ipc-new.sock', '/tmp/vscode-ipc-old.sock'],
            listeners: { '/tmp/vscode-ipc-old.sock': 7 },
            exes: { 7: `${SERVER}/node` },
            executables: [REMOTE_CLI],
            fails: shimFails,
        });
        await expect(openInVsCode('/w/claude.tsk', 4, { PATH: '/usr/bin' }, f.sys)).resolves.toBe(
            undefined,
        );
        expect(f.runs).toEqual([{ cli: REMOTE_CLI, sock: '/tmp/vscode-ipc-old.sock' }]);
    });

    it("tries the environment's socket first while it's live, then the newest, and stops at the first that opens", async () => {
        const f = fake({
            sockets: ['/tmp/vscode-ipc-a.sock', '/tmp/vscode-ipc-b.sock'],
            listeners: {
                '/tmp/vscode-ipc-env.sock': 5,
                '/tmp/vscode-ipc-a.sock': 6,
                '/tmp/vscode-ipc-b.sock': 6,
            },
            exes: { 5: `${SERVER}/node`, 6: `${SERVER}/node` },
            executables: [REMOTE_CLI],
            fails: (_cli, sock) => (sock?.endsWith('env.sock') ? 'timed out' : undefined),
        });
        await openInVsCode('/w/f', 0, { VSCODE_IPC_HOOK_CLI: '/tmp/vscode-ipc-env.sock' }, f.sys);
        expect(f.runs.map((r) => r.sock)).toEqual([
            '/tmp/vscode-ipc-env.sock',
            '/tmp/vscode-ipc-a.sock',
        ]);
    });

    it("passes over the environment's socket when nothing listens on it", async () => {
        const f = fake({
            sockets: ['/tmp/vscode-ipc-a.sock'],
            listeners: { '/tmp/vscode-ipc-a.sock': 6 },
        });
        await openInVsCode('/w/f', 0, { VSCODE_IPC_HOOK_CLI: '/tmp/vscode-ipc-gone.sock' }, f.sys);
        expect(f.runs.map((r) => r.sock)).toEqual(['/tmp/vscode-ipc-a.sock']);
    });

    it('runs code on PATH where the server has no remote CLI beside it', async () => {
        const f = fake({
            sockets: ['/tmp/vscode-ipc-a.sock'],
            listeners: { '/tmp/vscode-ipc-a.sock': 6 },
            exes: { 6: '/usr/share/code/code' },
        });
        await openInVsCode('/w/f', 0, {}, f.sys);
        expect(f.runs).toEqual([{ cli: 'code', sock: '/tmp/vscode-ipc-a.sock' }]);
    });

    it('without ss, takes every socket file as live, with code on PATH', async () => {
        const f = fake({
            sockets: ['/tmp/vscode-ipc-a.sock', '/tmp/vscode-ipc-b.sock'],
            noSs: true,
            fails: (_cli, sock) => (sock?.endsWith('a.sock') ? 'ENOENT' : undefined),
        });
        await expect(openInVsCode('/w/f', 0, {}, f.sys)).resolves.toBe(undefined);
        expect(f.runs).toEqual([
            { cli: 'code', sock: '/tmp/vscode-ipc-a.sock' },
            { cli: 'code', sock: '/tmp/vscode-ipc-b.sock' },
        ]);
    });

    it('with no socket at all, runs code as it is, for a desktop VS Code', async () => {
        const f = fake({ sockets: [] });
        await openInVsCode('/w/f', 2, {}, f.sys);
        expect(f.runs).toEqual([{ cli: 'code', sock: undefined }]);
    });

    it('says when no socket is live, and runs nothing', async () => {
        const f = fake({ sockets: ['/tmp/vscode-ipc-a.sock', '/tmp/vscode-ipc-b.sock'] });
        await expect(openInVsCode('/w/f', 0, {}, f.sys)).resolves.toBe(
            'no VS Code window to open it in: no live socket in /tmp',
        );
        expect(f.runs).toEqual([]);
    });

    it('says why the last one failed when none opens it', async () => {
        const f = fake({
            sockets: ['/tmp/vscode-ipc-a.sock'],
            listeners: { '/tmp/vscode-ipc-a.sock': 6 },
            fails: shimFails,
        });
        await expect(openInVsCode('/w/f', 0, {}, f.sys)).resolves.toBe(
            `VS Code didn't open it: ${SHIM}`,
        );
    });

    it('looks for sockets in $XDG_RUNTIME_DIR, else $TMPDIR, else /tmp, as VS Code makes them', async () => {
        const f = fake({ sockets: [] });
        await openInVsCode('/w/f', 0, { XDG_RUNTIME_DIR: '/run/user/1000', TMPDIR: '/t' }, f.sys);
        await openInVsCode('/w/f', 0, { TMPDIR: '/t' }, f.sys);
        await openInVsCode('/w/f', 0, {}, f.sys);
        expect(f.dirs).toEqual(['/run/user/1000', '/t', '/tmp']);
    });
});

describe('parseListeners', () => {
    it("reads each listener's path and pid from ss -xlpH, and skips one it can't name the pid of", () => {
        const out = [
            'u_str LISTEN 0      511    /tmp/vscode-ipc-8bba.sock 66991068            * 0    users:(("MainThread",pid=1030578,fd=23))',
            'u_str LISTEN 0      4096   /run/dbus/system_bus_socket 1234            * 0',
            'u_str LISTEN 0      511    @/tmp/.X11-unix/X0 99            * 0    users:(("Xorg",pid=12,fd=5))',
            '',
        ].join('\n');
        expect(parseListeners(out)).toEqual(
            new Map([
                ['/tmp/vscode-ipc-8bba.sock', 1030578],
                ['@/tmp/.X11-unix/X0', 12],
            ]),
        );
    });
});

const hasSs = (() => {
    try {
        execFileSync('ss', ['-V'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
})();

describe('openInVsCode, on the real system', () => {
    // Only the test's own sockets and a stand-in `code`: the environment is the test's, not the process's.
    it.skipIf(!hasSs)(
        'finds the live socket with ss, passes over a dead one, and runs code on PATH for a server with no remote CLI',
        async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsk-code-'));
            const live = path.join(dir, 'vscode-ipc-live.sock');
            const server = net.createServer();
            try {
                await new Promise<void>((resolve) => server.listen(live, resolve));
                // Newer, and nothing listens on it.
                fs.writeFileSync(path.join(dir, 'vscode-ipc-dead.sock'), '');
                const bin = path.join(dir, 'bin');
                const log = path.join(dir, 'code.log');
                fs.mkdirSync(bin);
                fs.writeFileSync(
                    path.join(bin, 'code'),
                    `#!/bin/sh\necho "$VSCODE_IPC_HOOK_CLI $*" >> '${log}'\n`,
                    { mode: 0o755 },
                );
                const env = { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: dir };
                await expect(openInVsCode('/w/f.tsk', 2, env)).resolves.toBe(undefined);
                expect(fs.readFileSync(log, 'utf8')).toBe(`${live} -g /w/f.tsk:3\n`);
            } finally {
                server.close();
                fs.rmSync(dir, { recursive: true, force: true });
            }
        },
    );
});
