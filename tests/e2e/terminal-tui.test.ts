import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';
const STAND_IN = path.join(__dirname, 'support', 'tui-stand-in.js');

/**
 * A click on `tsk:<id>` in a terminal also selects the task in the TUI beside
 * that terminal. The TUI is a stand-in (`support/tui-stand-in.ts`, the real
 * listener) run in a real VS Code terminal, plain or inside tmux on a server
 * of the test's own; the click is the provider's, driven through the API as
 * the terminal-link suite does. Each terminal's environment drops `TMUX`, so
 * nothing here can reach a tmux server it didn't start.
 */
suite('tsk:<id> in the terminal selects it in the TUI beside it', () => {
    let api: TskExtensionApi;
    let sample: string;
    let dir: string;
    let runtime: string;
    let tmuxSocket: string;
    const before = process.env.TSK_RUNTIME_DIR;
    const terminals: vscode.Terminal[] = [];
    const token = new vscode.CancellationTokenSource().token;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();
        const firstFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(firstFolder, 'expected a workspace folder');
        sample = path.join(firstFolder.uri.fsPath, 'sample.tsk');
        // Short, for the socket paths.
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsk-e2e-'));
        runtime = path.join(dir, 'rt');
        tmuxSocket = path.join(dir, 'tmux');
        process.env.TSK_RUNTIME_DIR = runtime;
    });

    suiteTeardown(async () => {
        for (const t of terminals) t.dispose();
        try {
            execFileSync('tmux', ['-S', tmuxSocket, 'kill-server'], { stdio: 'ignore' });
        } catch {
            // No server: the tmux test was skipped, or it has gone already.
        }
        if (before === undefined) delete process.env.TSK_RUNTIME_DIR;
        else process.env.TSK_RUNTIME_DIR = before;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /** A terminal running `command` under sh, without the tmux it was started from. */
    const terminal = (name: string, command: string) => {
        const t = vscode.window.createTerminal({
            name,
            shellPath: '/bin/sh',
            shellArgs: ['-c', command],
            env: { TSK_RUNTIME_DIR: runtime, TMUX: null, TMUX_PANE: null },
        });
        terminals.push(t);
        return t;
    };
    const lines = (log: string) =>
        fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    async function until(check: () => boolean, what: string, ms = 10_000) {
        const end = Date.now() + ms;
        while (!check()) {
            if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
            await new Promise((r) => setTimeout(r, 50));
        }
    }
    const standIn = (log: string) => `exec node '${STAND_IN}' '${sample}' '${log}'`;
    const click = async (line: string, t: vscode.Terminal) => {
        const provider = api.getTerminalLinkProvider();
        const context = { line, terminal: t } as vscode.TerminalLinkContext;
        const [link] = (await provider.provideTerminalLinks(context, token)) ?? [];
        assert.ok(link, `${line} should be a link`);
        await provider.handleTerminalLink(link);
    };

    test('a plain terminal: the TUI running in it, and not one in another terminal', async () => {
        const log = path.join(dir, 'plain.log');
        const tui = terminal('tsk tui', standIn(log));
        await until(() => lines(log).includes('listening'), 'the stand-in to listen');
        await click('tsk:m3task2', tui);
        assert.deepStrictEqual(lines(log), ['listening', 'm3task2']);
        assert.strictEqual(
            vscode.window.activeTextEditor?.selection.active.line,
            api.findTaskById('m3task2')?.line,
            'the editor reveals it as before',
        );
        const other = terminal('other', 'sleep 60');
        assert.ok(await other.processId);
        await click('tsk:m3task3', other);
        assert.deepStrictEqual(lines(log), ['listening', 'm3task2']);
    });

    test('in tmux: the TUI in the window the clicked client shows', async function () {
        try {
            execFileSync('tmux', ['-V'], { stdio: 'ignore' });
        } catch {
            this.skip();
        }
        const log = path.join(dir, 'tmux.log');
        // The terminal is the tmux client; the stand-in runs in the session's pane.
        const client = terminal(
            'tmux',
            `exec tmux -S '${tmuxSocket}' -f /dev/null new-session -s e2e -e TSK_RUNTIME_DIR='${runtime}' "${standIn(log)}"`,
        );
        await until(() => lines(log).includes('listening'), 'the stand-in in tmux to listen');
        await click('tsk:m3task3', client);
        assert.deepStrictEqual(lines(log), ['listening', 'm3task3']);
    });
});
