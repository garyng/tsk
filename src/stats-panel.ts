import * as vscode from 'vscode';
import { COMMANDS } from './constants';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import type { StatsHostToWebview, StatsWebviewToHost } from './lib/stats-protocol';
import { buildStatsView } from './lib/stats-view-model';
import { buildWebviewHtml, webviewLocalResourceRoots } from './webview-html';

const VIEW_TYPE = 'tsk.stats';

/**
 * Owns the "Tsk Stats" webview panel — an editor-area `WebviewPanel` (like
 * {@link NowPanel}) showing a GitHub-style activity calendar of task events plus
 * current-state count tiles. It loads `dist/webview/stats.js` under the shared
 * CSP, posts a host-built {@link StatsView} on the `ready` handshake, and
 * re-posts whenever the cache rescans (the panel's only input is the cache, so
 * there are no user actions to route back — the metric toggle is client-side).
 *
 * `registerWebviewPanelSerializer` revives a left-open / popped-out panel.
 */
export class StatsPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    /** Last viewmodel posted (serialized) — to skip re-posting an identical one. */
    private lastPosted: string | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly cache: CacheService,
        private readonly logger: Logger,
    ) {}

    /** Open the panel, or reveal it if already open. */
    open(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active);
            return;
        }
        this.adopt(
            vscode.window.createWebviewPanel(
                VIEW_TYPE,
                'Tsk Stats',
                vscode.ViewColumn.Active,
                this.webviewOptions(),
            ),
        );
    }

    /** Re-attach to a panel restored by the serializer (e.g. after a reload). */
    revive(panel: vscode.WebviewPanel): void {
        this.adopt(panel);
    }

    /** Re-render from the current cache state. A no-op when the panel is closed. */
    refresh(): void {
        this.postRender();
    }

    dispose(): void {
        this.panel?.dispose();
        this.panel = undefined;
    }

    // ── internals ───────────────────────────────────────────────────────────

    private adopt(panel: vscode.WebviewPanel): void {
        this.logger.debug(`${COMMANDS.openStats}: stats webview panel attached`);
        this.panel = panel;
        this.lastPosted = undefined; // a fresh webview needs the next render unconditionally
        panel.webview.options = this.webviewOptions();
        panel.webview.html = buildWebviewHtml(
            panel.webview,
            this.extensionUri,
            'stats.js',
            'Tsk Stats',
        );
        panel.webview.onDidReceiveMessage((message: StatsWebviewToHost) => {
            if (message?.type === 'ready') this.postRender();
        });
        panel.onDidDispose(() => {
            if (this.panel === panel) this.panel = undefined;
        });
    }

    private postRender(): void {
        if (!this.panel) return;
        const view = buildStatsView(
            this.cache.listAllTasks(),
            this.cache.listAllMetadata(),
            new Date(),
        );
        // Skip the cross-process post when nothing changed since the last render —
        // the rescan-tail fires on every edit/save/watcher event, most unrelated.
        const serialized = JSON.stringify(view);
        if (serialized === this.lastPosted) return;
        this.lastPosted = serialized;
        const message: StatsHostToWebview = { type: 'render', view };
        void this.panel.webview.postMessage(message);
    }

    private webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
        return {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: webviewLocalResourceRoots(this.extensionUri),
        };
    }
}

/**
 * Construct the {@link StatsPanel}, register the `tsk.openStats` command, and
 * register the serializer that revives a left-open / popped-out panel on reload.
 * Returns the panel so the caller can wire it into the rescan-tail refresh hook.
 */
export function registerStatsPanel(
    context: vscode.ExtensionContext,
    cache: CacheService,
    logger: Logger,
): StatsPanel {
    const panel = new StatsPanel(context.extensionUri, cache, logger);
    context.subscriptions.push(
        panel,
        vscode.commands.registerCommand(COMMANDS.openStats, () => panel.open()),
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(revived: vscode.WebviewPanel) {
                panel.revive(revived);
            },
        }),
    );
    return panel;
}
