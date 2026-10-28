import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';

/**
 * `tsk:<id>` in a terminal. VS Code asks a terminal link provider only for a
 * line under the mouse, which a test can't do, so the provider is driven
 * directly with a stand-in line, through the extension's API.
 */
suite('tsk:<id> in the terminal', () => {
    let api: TskExtensionApi;
    let sampleUri: vscode.Uri;
    const token = new vscode.CancellationTokenSource().token;
    const context = (line: string) =>
        ({ line, terminal: undefined }) as unknown as vscode.TerminalLinkContext;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();
        const firstFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(firstFolder, 'expected a workspace folder');
        sampleUri = vscode.Uri.joinPath(firstFolder.uri, 'sample.tsk');
    });

    setup(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('only ids the workspace knows are links, with the task’s text as the tooltip', async () => {
        const provider = api.getTerminalLinkProvider();
        const links = await provider.provideTerminalLinks(
            context('see tsk:m3task3 and tsk:zzzzzzzz, then run task tsk:test'),
            token,
        );
        assert.deepStrictEqual(
            (links ?? []).map((l) => ({
                start: l.startIndex,
                length: l.length,
                tooltip: l.tooltip,
            })),
            [{ start: 4, length: 11, tooltip: api.findTaskById('m3task3')?.content }],
        );
    });

    test('following a link reveals the task', async () => {
        const provider = api.getTerminalLinkProvider();
        const [link] = (await provider.provideTerminalLinks(context('tsk:m3task2'), token)) ?? [];
        assert.ok(link, 'tsk:m3task2 should be a link');
        await provider.handleTerminalLink(link);
        const active = vscode.window.activeTextEditor;
        assert.strictEqual(active?.document.uri.toString(), sampleUri.toString());
        assert.strictEqual(active?.selection.active.line, api.findTaskById('m3task2')?.line);
    });
});
