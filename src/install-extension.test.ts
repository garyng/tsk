import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `scripts/install-extension.sh` against stand-ins. A "server" is a copy of
 * socat named `node`, so `/proc/<pid>/exe` names a directory the test owns,
 * listening on a socket in the test's own TMPDIR, with a remote CLI beside it
 * that records how it was called. The script runs with no inherited
 * environment, so the only sockets it can find are the test's: nothing here
 * can reach a real VS Code.
 */

const SCRIPT = join(__dirname, '..', 'scripts', 'install-extension.sh');
const VSIX = 'artifacts/tsk-9.9.9.vsix';

function onPath(command: string): string | undefined {
    const found = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
    return found.status === 0 ? found.stdout.trim() : undefined;
}

const socat = onPath('socat');
const runnable = process.platform === 'linux' && socat !== undefined && onPath('ss') !== undefined;

/** The base image's `/usr/local/bin/code`, with no real `code` further down PATH. */
const SHIM = '#!/bin/sh\necho "code or code-insiders is not installed" >&2\nexit 127\n';
const record = (name: string) =>
    `#!/bin/sh\nprintf '%s %s %s\\n' ${name} "$VSCODE_IPC_HOOK_CLI" "$*" >> "$CALLS"\n`;

let tmp: string;
let servers: ChildProcess[];

beforeEach(() => {
    // Not os.tmpdir(): a socket's path is capped at 108 bytes.
    tmp = mkdtempSync('/tmp/tsk-install-');
    servers = [];
    mkdirSync(join(tmp, 'app', 'scripts'), { recursive: true });
    mkdirSync(join(tmp, 'app', 'artifacts'));
    copyFileSync(SCRIPT, join(tmp, 'app', 'scripts', 'install-extension.sh'));
    writeFileSync(join(tmp, 'app', 'package.json'), JSON.stringify({ version: '9.9.9' }));
    writeFileSync(join(tmp, 'app', VSIX), '');
    executable(join(tmp, 'shim', 'code'), SHIM);
});

afterEach(async () => {
    for (const server of servers) {
        if (server.exitCode !== null || server.signalCode !== null) continue;
        const exited = new Promise((done) => server.once('exit', done));
        server.kill();
        await exited;
    }
    rmSync(tmp, { recursive: true, force: true });
});

function executable(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    chmodSync(path, 0o755);
}

async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((tick) => setTimeout(tick, 20));
    }
}

/** A stand-in server listening on `vscode-ipc-<name>.sock`, its remote CLI `cli` (none if null). */
async function server(name: string, cli: string | null = record(name)): Promise<string> {
    const root = join(tmp, name);
    mkdirSync(root);
    copyFileSync(realpathSync(socat as string), join(root, 'node'));
    chmodSync(join(root, 'node'), 0o755);
    if (cli !== null) executable(join(root, 'bin', 'remote-cli', 'code'), cli);
    const sock = join(tmp, `vscode-ipc-${name}.sock`);
    const listening = spawn(join(root, 'node'), [`UNIX-LISTEN:${sock},fork`, '/dev/null'], {
        stdio: 'ignore',
    });
    servers.push(listening);
    await until(() => existsSync(sock), `${name} to listen`);
    return sock;
}

/** A socket file nothing listens on, as a window that closed without cleaning up leaves. */
function deadSocket(name: string): string {
    const sock = join(tmp, `vscode-ipc-${name}.sock`);
    const listen = `require('net').createServer().listen(${JSON.stringify(sock)}, () => process.exit(0))`;
    spawnSync(process.execPath, ['-e', listen]);
    expect(existsSync(sock)).toBe(true);
    return sock;
}

/** Sets the sockets' mtimes in the order given, oldest first. */
function inOrder(...socks: string[]): void {
    const now = Date.now() / 1000;
    for (const [i, sock] of socks.entries()) utimesSync(sock, now + i, now + i);
}

/** A PATH of `first`, then node and the system's tools. */
const path = (first: string) => [first, dirname(process.execPath), '/usr/bin', '/bin'].join(':');

function install(env: Record<string, string> = {}) {
    return spawnSync('bash', [join(tmp, 'app', 'scripts', 'install-extension.sh')], {
        encoding: 'utf8',
        timeout: 20_000,
        env: {
            PATH: path(join(tmp, 'shim')),
            TMPDIR: tmp,
            CALLS: join(tmp, 'calls'),
            ...env,
        },
    });
}

function calls(): string[] {
    const file = join(tmp, 'calls');
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
}

describe.skipIf(!runnable)('install-extension.sh', () => {
    it('passes over the base image’s code shim for the remote CLI beside the server on the socket', async () => {
        const sock = await server('srv');
        const run = install({ VSCODE_IPC_HOOK_CLI: sock });
        expect(run.stderr).toBe('');
        expect(run.status).toBe(0);
        expect(calls()).toEqual([`srv ${sock} --install-extension ${VSIX} --force`]);
    });

    it('takes the newest socket a server listens on when the shell has none, passing over a dead one', async () => {
        const older = await server('old');
        const newer = await server('new');
        inOrder(older, newer, deadSocket('dead'));
        const run = install();
        expect(run.status, run.stderr).toBe(0);
        expect(calls()).toEqual([`new ${newer} --install-extension ${VSIX} --force`]);
    });

    it('takes the newest live socket when VSCODE_IPC_HOOK_CLI names one that is gone', async () => {
        const sock = await server('srv');
        const run = install({ VSCODE_IPC_HOOK_CLI: join(tmp, 'vscode-ipc-gone.sock') });
        expect(run.status, run.stderr).toBe(0);
        expect(calls()).toEqual([`srv ${sock} --install-extension ${VSIX} --force`]);
    });

    it('uses the code on PATH when the server has no remote CLI, as a desktop VS Code has none', async () => {
        const sock = await server('desktop', null);
        executable(join(tmp, 'desktop-bin', 'code'), record('path'));
        const run = install({
            VSCODE_IPC_HOOK_CLI: sock,
            PATH: path(join(tmp, 'desktop-bin')),
        });
        expect(run.status, run.stderr).toBe(0);
        expect(calls()).toEqual([`path ${sock} --install-extension ${VSIX} --force`]);
    });

    it('says so, and runs nothing, when no socket has a server listening', () => {
        deadSocket('dead');
        const run = install();
        expect(run.status).toBe(1);
        expect(run.stderr).toMatch(/no live VS Code IPC socket/);
        expect(calls()).toEqual([]);
    });

    it('gives up on a window that never answers, leaving nothing of the CLI running', async () => {
        const pidFile = join(tmp, 'cli.pid');
        // The real remote CLI is a sh script running node as its child.
        const sock = await server('away', `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\nwait\n`);
        const run = install({ VSCODE_IPC_HOOK_CLI: sock, TSK_INSTALL_TIMEOUT: '1' });
        expect(run.status).toBe(124);
        expect(run.stderr).toContain(`VS Code didn't answer within 1 s on ${sock}`);
        const child = readFileSync(pidFile, 'utf8').trim();
        const alive = () => {
            const stat = spawnSync('ps', ['-o', 'stat=', '-p', child], { encoding: 'utf8' });
            return stat.status === 0 && !stat.stdout.trim().startsWith('Z');
        };
        await until(() => !alive(), 'the CLI’s child to exit');
    });
});
