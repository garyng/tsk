import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Open a file at a line in VS Code with its `code` command line, as
 * `scripts/install-extension.sh` finds it. Inside a
 * devcontainer, `code` reaches the window through the socket named by
 * `VSCODE_IPC_HOOK_CLI`, and VS Code makes a new one on every reconnect, so a
 * shell started earlier holds a dead one, and a shell VS Code didn't start (a
 * tmux pane) has none. So: the environment's socket while it's live, then the
 * newest live ones. And a shell VS Code didn't start finds only the base
 * image's `code` on PATH, a shim that fails "code or code-insiders is not
 * installed": the CLI that works is the remote CLI beside the node of the
 * server listening on the socket, the same version as it.
 */

const IPC_RE = /^vscode-ipc-.*\.sock$/;
const TIMEOUT_MS = 5000;
/** `ss` answers at once; one that doesn't is treated as missing. */
const SS_TIMEOUT_MS = 1000;

/**
 * Each listening Unix socket's path and pid in `ss -xlpH` output, as
 * `u_str LISTEN 0 511 <path> <inode> * 0 users:(("node",pid=<pid>,fd=<fd>))`.
 * Read by hand, as the install script does: no package reads `ss`, and the
 * fields are fixed.
 */
export function parseListeners(out: string): Map<string, number> {
    const found = new Map<string, number>();
    for (const line of out.split('\n')) {
        const where = line.trim().split(/\s+/)[4];
        const pid = /pid=(\d+)/.exec(line)?.[1];
        if (where && pid) found.set(where, Number(pid));
    }
    return found;
}

/** What opening reaches the system through; tests pass fakes. */
export interface VsCodeSystem {
    /** The `vscode-ipc-*.sock` files in `dir`, newest first. */
    sockets(dir: string): string[];
    /** Each listening Unix socket's path and pid, from `ss`; undefined where there's no `ss`. */
    listeners(): Promise<Map<string, number> | undefined>;
    /** The binary process `pid` runs. */
    exeOf(pid: number): string | undefined;
    isExecutable(file: string): boolean;
    /** Run `cli` with `args`: undefined on success, else why it failed. */
    run(cli: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string | undefined>;
}

export const system: VsCodeSystem = {
    sockets: (dir) => {
        try {
            return fs
                .readdirSync(dir)
                .filter((n) => IPC_RE.test(n))
                .map((n) => path.join(dir, n))
                .map((p) => ({ p, t: fs.statSync(p).mtimeMs }))
                .sort((a, b) => b.t - a.t)
                .map((s) => s.p);
        } catch {
            return [];
        }
    },
    listeners: () =>
        new Promise((resolve) => {
            execFile('ss', ['-xlpH'], { timeout: SS_TIMEOUT_MS }, (err, out) =>
                resolve(err ? undefined : parseListeners(out)),
            );
        }),
    exeOf: (pid) => {
        try {
            return fs.readlinkSync(`/proc/${pid}/exe`);
        } catch {
            return undefined;
        }
    },
    isExecutable: (file) => {
        try {
            fs.accessSync(file, fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    },
    run: (cli, args, env) =>
        new Promise((resolve) => {
            execFile(cli, args, { env, timeout: TIMEOUT_MS }, (err, _out, stderr) =>
                resolve(err ? stderr.trim().split('\n')[0] || err.message : undefined),
            );
        }),
};

/** Undefined on success, else why it failed. `line` is zero-based. */
export async function openInVsCode(
    file: string,
    line: number,
    env: NodeJS.ProcessEnv,
    sys: VsCodeSystem = system,
): Promise<string | undefined> {
    const args = ['-g', `${file}:${line + 1}`];
    const dir = env.XDG_RUNTIME_DIR || env.TMPDIR || '/tmp';
    const files = [
        ...new Set([env.VSCODE_IPC_HOOK_CLI, ...sys.sockets(dir)].filter((s): s is string => !!s)),
    ];
    // A desktop VS Code has no socket to look for: its `code` finds the window itself.
    if (files.length === 0) {
        const why = await sys.run('code', args, env);
        return why === undefined ? undefined : `VS Code didn't open it: ${why}`;
    }
    const listeners = await sys.listeners();
    // Where `ss` can't say, a socket file is taken as live.
    const live = listeners ? files.filter((f) => listeners.has(f)) : files;
    if (live.length === 0) return `no VS Code window to open it in: no live socket in ${dir}`;
    let why: string | undefined;
    for (const sock of live) {
        const server = listeners?.get(sock);
        const exe = server === undefined ? undefined : sys.exeOf(server);
        const beside = exe && path.join(path.dirname(exe), 'bin', 'remote-cli', 'code');
        const cli = beside && sys.isExecutable(beside) ? beside : 'code';
        why = await sys.run(cli, args, { ...env, VSCODE_IPC_HOOK_CLI: sock });
        if (why === undefined) return undefined;
    }
    return `VS Code didn't open it: ${why}`;
}
