import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { COMMANDS } from './constants';
import type { Logger } from './lib/logger';
import type { HostToWebview, WebviewToHost } from './lib/now-protocol';
import type { NowStore } from './lib/now-store';

const VIEW_TYPE = 'tsk.nowStack';

/**
 * Owns the single "Now Stack" webview panel — an EDITOR-area `WebviewPanel` (not
 * a sidebar view) so the user can "Move/Copy into a New Window". It loads the
 * built React bundle (`dist/webview/now-stack.js`) under a nonce + strict CSP,
 * bridges messages, and re-renders whenever the now-tree changes.
 *
 * M46 is the SHELL: `render` carries no rows yet (the webview shows a
 * placeholder); the `@grida/tree-view` UI + the resolved row viewmodel land in
 * M47. The store subscription, the `ready` handshake, and the
 * `registerWebviewPanelSerializer` revive (so a popped-out panel survives a
 * reload) are all wired now.
 */
export class NowPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private readonly storeSub: { dispose(): void };

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly nowStore: NowStore,
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
        if (message?.type === 'ready') {
            // The client has mounted and is listening — safe to paint now.
            this.postRender();
        }
    }

    private postRender(): void {
        const message: HostToWebview = { type: 'render' };
        void this.panel?.webview.postMessage(message);
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
            `font-src ${webview.cspSource}`,
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
    logger: Logger,
): NowPanel {
    const panel = new NowPanel(context.extensionUri, nowStore, logger);
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
