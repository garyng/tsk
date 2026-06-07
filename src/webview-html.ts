import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/**
 * Build the HTML shell shared by every tsk webview panel (Now Stack, Stats, Task
 * List): a strict CSP with a per-call nonce, the bundled React entry loaded from
 * `dist/webview/<scriptFileName>` via `asWebviewUri`, and an empty `#root` for
 * the client to mount into.
 *
 * Keeping the CSP + nonce + resource wiring in one place means a third panel is
 * a one-line call, not a copy of the security-sensitive boilerplate. The CSP
 * allows: inline styles (the bundles inject their CSS as a `<style>` tag),
 * `data:` fonts (the codicon font is inlined), and scripts from the extension's
 * own origin (`${webview.cspSource}`) plus the per-load nonce. Origin-scoped
 * `script-src` (not nonce-only) is what lets an entry import Vite's shared React
 * chunk — entry and chunk both live in `dist/webview`, which
 * {@link webviewLocalResourceRoots} locks `localResourceRoots` to, so nothing
 * outside the extension's own bundles can load. This is the standard VS Code +
 * Vite webview CSP.
 */
export function buildWebviewHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    scriptFileName: string,
    title: string,
): string {
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'dist', 'webview', scriptFileName),
    );
    const nonce = randomBytes(16).toString('hex');
    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} https: data:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}' ${webview.cspSource}`,
        `font-src ${webview.cspSource} data:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
</head>
<body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** The only directory a tsk webview may load resources from — the built bundles. */
export function webviewLocalResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
    return [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')];
}
