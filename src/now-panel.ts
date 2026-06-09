import * as vscode from 'vscode';
import { COMMANDS, INTERNAL_COMMANDS } from './constants';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import type { HostToWebview, WebviewToHost } from './lib/now-protocol';
import type { NowStore } from './lib/now-store';
import { buildNowTreeView } from './lib/now-tree-view-model';
import { buildWebviewHtml, webviewLocalResourceRoots } from './webview-html';

const VIEW_TYPE = 'tsk.nowStack';

/** How often a visible panel re-renders so relative "when" times don't freeze. */
const RELATIVE_TIME_TICK_MS = 60_000;

/**
 * Owns the single "Now Stack" webview panel — an EDITOR-area `WebviewPanel` (not
 * a sidebar view) so the user can "Move/Copy into a New Window". It loads the
 * built React bundle (`dist/webview/now-stack.js`) under a nonce + strict CSP,
 * bridges messages, and re-renders whenever the now-tree changes.
 *
 * Each render builds the resolved, linear-compaction viewmodel host-side
 * (`buildNowTreeView` over the store state + the cache as the label resolver)
 * and posts it; the webview reconstructs the grida tree and renders. The `ready`
 * handshake guards the first paint, the store subscription drives re-renders,
 * and `registerWebviewPanelSerializer` revives a popped-out panel after reload.
 */
export class NowPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    /** The last viewmodel posted (serialized) — to skip re-posting an identical one. */
    private lastPosted: string | undefined;
    /** Per-minute re-render so relative "when" times advance on an idle panel. */
    private ticker: ReturnType<typeof setInterval> | undefined;
    private readonly storeSub: { dispose(): void };
    private readonly editorSub: { dispose(): void };
    /**
     * The editor group jumps navigate to — the markdown-preview "source" model.
     * Tracks the last ACTIVE non-panel text editor (below), so it stays correct
     * across the panel being revived by the serializer or popped into a new
     * window — neither of which runs `open()`.
     */
    private sourceColumn: vscode.ViewColumn = vscode.ViewColumn.One;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly nowStore: NowStore,
        private readonly cache: CacheService,
        private readonly logger: Logger,
    ) {
        // Re-render on every tree change (mark / switch / prune / clear). The
        // `ready` handshake guards the first paint; later changes post directly.
        this.storeSub = this.nowStore.onDidChange(() => this.postRender());
        this.sourceColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        this.editorSub = vscode.window.onDidChangeActiveTextEditor((editor) => {
            // Keep the source group fresh — but never the panel's own column
            // (a jump there would open over the panel / spawn a stray tab).
            const col = editor?.viewColumn;
            if (col !== undefined && col !== this.panel?.viewColumn) this.sourceColumn = col;
        });
    }

    /** Open the panel (or reveal it if already open) beside the active editor. */
    open(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside);
            return;
        }
        this.adopt(
            vscode.window.createWebviewPanel(
                VIEW_TYPE,
                'Now Stack',
                vscode.ViewColumn.Beside,
                this.webviewOptions(),
            ),
        );
    }

    /** Re-attach to a panel restored by the serializer (e.g. after a reload). */
    revive(panel: vscode.WebviewPanel): void {
        this.adopt(panel);
    }

    /**
     * Re-render from the current store + cache state. The store's `onDidChange`
     * already covers tree mutations; this is the hook for a CACHE rescan (e.g.
     * after `tsk.rebuildCache`), where labels can change but the tree doesn't.
     * A no-op when the panel is closed.
     */
    refresh(): void {
        this.postRender();
    }

    dispose(): void {
        this.stopTicker();
        this.storeSub.dispose();
        this.editorSub.dispose();
        this.panel?.dispose();
        this.panel = undefined;
    }

    // ── internals ───────────────────────────────────────────────────────────

    private adopt(panel: vscode.WebviewPanel): void {
        this.logger.debug(`${COMMANDS.openNowStack}: now-stack webview panel attached`);
        this.panel = panel;
        this.lastPosted = undefined; // a fresh webview needs the next render unconditionally
        panel.webview.options = this.webviewOptions();
        panel.webview.html = this.html(panel.webview);
        panel.webview.onDidReceiveMessage((message: WebviewToHost) => this.onMessage(message));
        // Re-render when the panel is revealed (instant freshness) and once a
        // minute while it's visible (relative "when" times advance on idle).
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
        this.ticker = setInterval(() => {
            if (this.panel?.visible) this.postRender();
        }, RELATIVE_TIME_TICK_MS);
    }

    private stopTicker(): void {
        if (this.ticker !== undefined) {
            clearInterval(this.ticker);
            this.ticker = undefined;
        }
    }

    private onMessage(message: WebviewToHost): void {
        // Thin router: the C3a now-tree commands do the work, the store's
        // `onDidChange` then drives the re-render. `ready` is the first-paint
        // handshake. Unknown / malformed messages are ignored.
        switch (message?.type) {
            case 'ready':
                this.postRender();
                return;
            case 'jump':
                void vscode.commands.executeCommand(
                    INTERNAL_COMMANDS.nowJump,
                    message.id,
                    this.sourceColumn,
                );
                return;
            case 'switchTo':
                void vscode.commands.executeCommand(INTERNAL_COMMANDS.nowSwitchTo, message.entryId);
                return;
            case 'bump':
                void vscode.commands.executeCommand(INTERNAL_COMMANDS.nowBump, message.entryId);
                return;
            case 'remove':
                void vscode.commands.executeCommand(INTERNAL_COMMANDS.nowRemove, message.entryId);
                return;
            case 'pruneSubtree':
                void vscode.commands.executeCommand(
                    INTERNAL_COMMANDS.nowPruneSubtree,
                    message.entryId,
                );
                return;
            case 'pruneChildren':
                void vscode.commands.executeCommand(
                    INTERNAL_COMMANDS.nowPruneChildren,
                    message.entryId,
                );
                return;
            case 'back':
                void vscode.commands.executeCommand(INTERNAL_COMMANDS.nowBack);
                return;
            case 'pruneOffPath':
                void vscode.commands.executeCommand(INTERNAL_COMMANDS.nowPruneOffPath);
                return;
            case 'clear':
                void vscode.commands.executeCommand(COMMANDS.nowClear);
                return;
        }
    }

    private postRender(): void {
        if (!this.panel) return;
        const rows = buildNowTreeView(
            this.nowStore.getState(),
            (id) => this.cache.lookupById(id),
            new Date(),
        );
        // Skip the cross-process post + webview re-render when nothing visible
        // changed since the last post. The rescan-tail fires `refresh()` on every
        // edit/save/watcher event (most unrelated to any now-task), so re-posting
        // an identical viewmodel is pure churn + flicker. Relative `when` drifts
        // at minute granularity, so a genuine time change still posts.
        const serialized = JSON.stringify(rows);
        if (serialized === this.lastPosted) return;
        this.lastPosted = serialized;
        const message: HostToWebview = { type: 'render', rows };
        void this.panel.webview.postMessage(message);
    }

    private webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
        return {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: webviewLocalResourceRoots(this.extensionUri),
        };
    }

    private html(webview: vscode.Webview): string {
        return buildWebviewHtml(webview, this.extensionUri, 'now-stack.js', 'Now Stack');
    }
}

/**
 * Construct the {@link NowPanel}, register the `tsk.now.openStack` command, and
 * register the serializer that revives a left-open / popped-out panel on reload.
 * Returns the panel so the caller can wire it into later refresh hooks (M47).
 */
export function registerNowPanel(
    context: vscode.ExtensionContext,
    nowStore: NowStore,
    cache: CacheService,
    logger: Logger,
): NowPanel {
    const panel = new NowPanel(context.extensionUri, nowStore, cache, logger);
    context.subscriptions.push(
        panel,
        vscode.commands.registerCommand(COMMANDS.openNowStack, () => panel.open()),
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(revived: vscode.WebviewPanel) {
                panel.revive(revived);
            },
        }),
    );
    return panel;
}
