import * as vscode from 'vscode';
import { COMMANDS } from './constants';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import { type Metric, taskIdsForDay } from './lib/stats-aggregation';
import type { StatsHostToWebview, StatsWebviewToHost } from './lib/stats-protocol';
import { buildStatsView } from './lib/stats-view-model';
import { buildWebviewHtml, webviewLocalResourceRoots } from './webview-html';

const VIEW_TYPE = 'tsk.stats';

/** Banner label per metric for the stats → task-list day jump (`all` → "Activity"). */
const METRIC_LABEL: Record<Metric, string> = {
    all: 'Activity',
    created: 'Created',
    started: 'Started',
    completed: 'Completed',
    cancelled: 'Cancelled',
    moved: 'Moved',
};

/** How often a visible panel checks whether the local date rolled (trailing-window advance). */
const RANGE_TICK_MS = 60_000;

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
    /** Advances the trailing-year window across midnight on an idle panel. */
    private ticker: ReturnType<typeof setInterval> | undefined;
    private lastTickDate: string | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly cache: CacheService,
        private readonly logger: Logger,
        /** Open the task list filtered to a day's tasks (wired to {@link TaskListPanel}). */
        private readonly onJumpToDay?: (ids: string[], label: string) => void,
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
        this.stopTicker();
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
            else if (message?.type === 'jumpToDay') this.jumpToDay(message.date, message.metric);
        });
        // Re-render when revealed; advance the trailing-year window when the
        // local date rolls over while the panel is left open across midnight.
        panel.onDidChangeViewState(() => {
            if (panel.visible) this.postRender();
        });
        panel.onDidDispose(() => {
            if (this.panel === panel) {
                this.panel = undefined;
                this.stopTicker();
            }
        });
        this.startTicker();
    }

    private startTicker(): void {
        this.stopTicker();
        this.lastTickDate = new Date().toDateString();
        this.ticker = setInterval(() => {
            const today = new Date().toDateString();
            if (today === this.lastTickDate) return;
            this.lastTickDate = today;
            if (this.panel?.visible) this.postRender();
        }, RANGE_TICK_MS);
    }

    private stopTicker(): void {
        if (this.ticker !== undefined) {
            clearInterval(this.ticker);
            this.ticker = undefined;
        }
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

    /** A calendar-day click: resolve the day's task ids for `metric` and hand off. */
    private jumpToDay(date: string, metric: Metric): void {
        const ids = taskIdsForDay(this.cache.listAllMetadata(), metric, date);
        this.onJumpToDay?.(ids, `${METRIC_LABEL[metric]} · ${date}`);
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
    onJumpToDay?: (ids: string[], label: string) => void,
): StatsPanel {
    const panel = new StatsPanel(context.extensionUri, cache, logger, onJumpToDay);
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
