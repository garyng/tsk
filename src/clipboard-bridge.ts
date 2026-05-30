import {
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    type Stats,
    unwatchFile,
    watchFile,
} from 'node:fs';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import {
    CLIPBOARD_BRIDGE_ENABLED_KEY,
    CLIPBOARD_BRIDGE_ENABLED_SETTING,
    CLIPBOARD_BRIDGE_PATH_KEY,
    CLIPBOARD_BRIDGE_PATH_SETTING,
    CLIPBOARD_BRIDGE_POLL_INTERVAL_MS,
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
 * **Why `fs.watchFile` (stat-polling), not `fs.watch` (inotify).** The
 * common writer is VS Code's own editor save, which writes a temp file
 * and renames it over the target — swapping the inode. An inode-bound
 * `fs.watch` follows the *old* inode and goes silent after the first
 * atomic save. `fs.watchFile` re-stats the *path* each interval, so it
 * follows the rename, and also works on devcontainer / WSL2 mounts where
 * inotify is unreliable. The cost is up to one poll-interval of latency
 * (see {@link CLIPBOARD_BRIDGE_POLL_INTERVAL_MS}) — imperceptible for
 * clipboard use, and the interval naturally coalesces burst writes.
 */
class ClipboardBridge {
    private watchedPath: string | undefined;
    private watchListener: ((curr: Stats, prev: Stats) => void) | undefined;

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
        // The `false` fallback is the safe-off default if the setting is
        // somehow absent; VSCode returns the package.json default (`false`)
        // for this contributed setting, so the manifest stays the single
        // source of truth — no mirrored constant in code.
        const enabled = config.get<boolean>(CLIPBOARD_BRIDGE_ENABLED_KEY, false);
        if (!enabled) return;

        // Throwaway '' fallback: VSCode returns the package.json default for
        // this contributed setting, so the manifest is the single source of
        // truth for the path (same pattern as cache.path / tags.path).
        const rawPath = config.get<string>(CLIPBOARD_BRIDGE_PATH_KEY, '');
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
            // The default path lives under `.vscode/tsk/`, which may not
            // exist yet (cache.db is the usual creator). Make the parent
            // dir before touching the file.
            mkdirSync(dirname(path), { recursive: true });
            // Touch the file so `watchFile` has a baseline to poll. Append
            // mode creates-if-missing without truncating existing content
            // (and without bumping mtime when it already exists, so no
            // spurious initial fire).
            closeSync(openSync(path, 'a'));
            this.watchedPath = path;
            this.watchListener = (curr, prev) => {
                // watchFile fires whenever the stat changed; only react when
                // the modification time actually advanced (ignore atime-only
                // touches). Equal mtime → nothing to copy.
                if (curr.mtimeMs === prev.mtimeMs) return;
                this.copyToClipboard(path);
            };
            watchFile(path, { interval: CLIPBOARD_BRIDGE_POLL_INTERVAL_MS }, this.watchListener);
            this.logger.info(
                `clipboard-bridge: watching ${path} (stat-poll ${CLIPBOARD_BRIDGE_POLL_INTERVAL_MS}ms)`,
            );
        } catch (err) {
            this.logger.error(
                `clipboard-bridge: failed to watch ${path}: ${(err as Error).message}`,
            );
            this.stop();
        }
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

    /** Stop polling the watch file. Safe to call repeatedly. */
    stop(): void {
        if (this.watchedPath && this.watchListener) {
            unwatchFile(this.watchedPath, this.watchListener);
            this.logger.info(`clipboard-bridge: stopped watching ${this.watchedPath}`);
        }
        this.watchedPath = undefined;
        this.watchListener = undefined;
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
