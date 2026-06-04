import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { COMMANDS, INTERNAL_COMMANDS } from './constants';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import type { HostToWebview, WebviewToHost } from './lib/now-protocol';
import type { NowStore } from './lib/now-store';
import { buildNowTreeView } from './lib/now-tree-view-model';

const VIEW_TYPE = 'tsk.nowStack';

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
    private readonly storeSub: { dispose(): void };

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly nowStore: NowStore,
        private readonly cache: CacheService,
        private readonly logger: Logger,
    ) {
        // Re-render on every tree change (mark / switch / prune / clear). The
        // `ready` handshake guards the first paint; later changes post directly.
        this.storeSub = this.nowStore.onDidChange(() => this.postRender());
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

    dispose(): void {
        this.storeSub.dispose();
        this.panel?.dispose();
        this.panel = undefined;
    }

    // ── internals ───────────────────────────────────────────────────────────

    private adopt(panel: vscode.WebviewPanel): void {
        this.logger.debug(`${COMMANDS.openNowStack}: now-stack webview panel attached`);
        this.panel = panel;
        panel.webview.options = this.webviewOptions();
        panel.webview.html = this.html(panel.webview);
        panel.webview.onDidReceiveMessage((message: WebviewToHost) => this.onMessage(message));
        panel.onDidDispose(() => {
            if (this.panel === panel) this.panel = undefined;
        });
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
                void vscode.commands.executeCommand(INTERNAL_COMMANDS.nowJump, message.id);
                return;
            case 'switchTo':
                void vscode.commands.executeCommand(INTERNAL_COMMANDS.nowSwitchTo, message.entryId);
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
        const message: HostToWebview = { type: 'render', rows };
        void this.panel.webview.postMessage(message);
    }

    private webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
        return {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
        };
    }

    private html(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'now-stack.js'),
        );
        const nonce = randomBytes(16).toString('hex');
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} https: data:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
            `font-src ${webview.cspSource} data:`,
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Now Stack</title>
</head>
<body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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
