import { closeSync, type FSWatcher, openSync, readFileSync, watch } from 'node:fs';
import * as vscode from 'vscode';
import {
    CLIPBOARD_BRIDGE_DEBOUNCE_MS,
    CLIPBOARD_BRIDGE_ENABLED_KEY,
    CLIPBOARD_BRIDGE_ENABLED_SETTING,
    CLIPBOARD_BRIDGE_PATH_KEY,
    CLIPBOARD_BRIDGE_PATH_SETTING,
    DEFAULT_CLIPBOARD_BRIDGE_ENABLED,
    DEFAULT_CLIPBOARD_BRIDGE_PATH,
} from './constants';
import { resolveBridgePath } from './lib/clipboard-bridge-path';
import type { Logger } from './lib/logger';

/**
 * Bridges a watched file to the host clipboard. Devcontainers can't reach
 * the host clipboard via the usual tools (`xclip` / `wl-copy` / `clip.exe`
 * / `pbcopy`), OSC 52 doesn't survive Claude Code's TUI, and the bundled
 * `code` CLI has no clipboard subcommand — but the *extension host* runs
 * with `vscode.env.clipboard` access. So any process that can write a file
 * (a shell, the `git-commit-phase` skill) can hand text to the host
 * clipboard by writing the watch file.
 *
 * Opt-in (`tsk.clipboard.bridgeEnabled`, default off): silently watching a
 * file and pushing its contents to the clipboard is surprising behavior to
 * enable by default.
 *
 * **Watch caveat.** We `fs.watch` the file directly, which tracks the inode.
 * Truncate-and-rewrite (`echo > file`, our skill's write) keeps the inode
 * and fires correctly. An *atomic* writer (write-temp-then-rename) would
 * swap the inode and the watch would go stale — not a concern for the
 * shell / skill writers we target, but documented so a future integration
 * knows to write in place.
 */
class ClipboardBridge {
    private watcher: FSWatcher | undefined;
    private watchedPath: string | undefined;
    private debounceTimer: NodeJS.Timeout | undefined;

    constructor(private readonly logger: Logger) {}

    /**
     * Read current settings and (re)align the watcher with them. Called on
     * activation and whenever the two bridge settings change. Idempotent:
     * tears down any existing watch, then starts a fresh one iff the
     * bridge is enabled and resolves to a path.
     */
    reconcile(): void {
        this.stop();

        const config = vscode.workspace.getConfiguration('tsk');
        const enabled = config.get<boolean>(
            CLIPBOARD_BRIDGE_ENABLED_KEY,
            DEFAULT_CLIPBOARD_BRIDGE_ENABLED,
        );
        if (!enabled) return;

        const rawPath = config.get<string>(
            CLIPBOARD_BRIDGE_PATH_KEY,
            DEFAULT_CLIPBOARD_BRIDGE_PATH,
        );
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const resolved = resolveBridgePath(rawPath, workspaceFolder);
        if (!resolved) {
            this.logger.warn(
                'clipboard-bridge: enabled but no path could be resolved (no workspace folder?). Bridge inactive.',
            );
            return;
        }

        this.start(resolved);
    }

    private start(path: string): void {
        try {
            // Touch the file so `fs.watch` has something to attach to.
            closeSync(openSync(path, 'a'));
            this.watcher = watch(path, (eventType) => {
                if (eventType !== 'change' && eventType !== 'rename') return;
                this.scheduleCopy(path);
            });
            this.watchedPath = path;
            this.logger.info(`clipboard-bridge: watching ${path}`);
        } catch (err) {
            this.logger.error(
                `clipboard-bridge: failed to watch ${path}: ${(err as Error).message}`,
            );
            this.stop();
        }
    }

    private scheduleCopy(path: string): void {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            this.copyToClipboard(path);
        }, CLIPBOARD_BRIDGE_DEBOUNCE_MS);
    }

    private copyToClipboard(path: string): void {
        let contents: string;
        try {
            contents = readFileSync(path, 'utf8');
        } catch (err) {
            this.logger.error(
                `clipboard-bridge: failed to read ${path}: ${(err as Error).message}`,
            );
            return;
        }
        void vscode.env.clipboard.writeText(contents).then(
            () =>
                this.logger.info(`clipboard-bridge: copied ${contents.length} chars from ${path}`),
            (err: unknown) =>
                this.logger.error(
                    `clipboard-bridge: clipboard write failed: ${(err as Error).message}`,
                ),
        );
    }

    /** Close the watcher + cancel any pending copy. Safe to call repeatedly. */
    stop(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
        if (this.watcher) {
            this.watcher.close();
            this.watcher = undefined;
            this.logger.info(`clipboard-bridge: stopped watching ${this.watchedPath}`);
            this.watchedPath = undefined;
        }
    }

    dispose(): void {
        this.stop();
    }
}

/**
 * Wire the clipboard bridge into activation: build the watcher, do an
 * initial `reconcile`, and re-reconcile whenever either bridge setting
 * changes. The bridge + the config listener are pushed onto
 * `context.subscriptions` so deactivation closes the watcher.
 */
export function registerClipboardBridge(context: vscode.ExtensionContext, logger: Logger): void {
    const bridge = new ClipboardBridge(logger);
    context.subscriptions.push(bridge);

    bridge.reconcile();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (
                event.affectsConfiguration(CLIPBOARD_BRIDGE_ENABLED_SETTING) ||
                event.affectsConfiguration(CLIPBOARD_BRIDGE_PATH_SETTING)
            ) {
                bridge.reconcile();
            }
        }),
    );
}
