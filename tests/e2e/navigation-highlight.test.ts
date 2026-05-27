import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Navigation-highlight e2e (M10/A). Drives `tsk.goToParent` against the
 * `dup.tsk` fixture parent/child pair and asserts highlight state via
 * `api.getNavigationHighlight()`.
 *
 * Why expose a test-only API instead of scraping decorations? VSCode
 * doesn't expose the active decoration set for a `DiagnosticCollection`
 * or `TextEditorDecorationType`; the only way to verify a decoration
 * landed is to read internal state. The `getNavigationHighlight`
 * snapshot is a thin delegation to `NavigationHighlight.getCurrent()`,
 * the same state the listener-clear paths mutate.
 */
suite('navigation highlight', () => {
    let api: TskExtensionApi;
    let dupUri: vscode.Uri;
    let sampleUri: vscode.Uri;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();

        const firstFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(firstFolder, 'expected a workspace folder');
        dupUri = vscode.Uri.joinPath(firstFolder.uri, 'dup.tsk');
        sampleUri = vscode.Uri.joinPath(firstFolder.uri, 'sample.tsk');
    });

    setup(async () => {
        // Each test starts from a known state — close any leftover editors
        // and the prior highlight from a previous test.
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await new Promise((resolve) => setImmediate(resolve));
    });

    test('navigate sets a whole-line highlight on the target', async () => {
        await vscode.commands.executeCommand('tsk.goToParent', 'e2e-graph-parent');
        await new Promise((resolve) => setImmediate(resolve));

        const parent = api.lookupGraph('e2e-graph-parent');
        assert.ok(parent);
        const highlight = api.getNavigationHighlight();
        assert.ok(highlight, 'expected an active highlight after navigate');
        assert.strictEqual(highlight.uri, dupUri.toString());
        assert.strictEqual(highlight.line, parent.line);
    });

    test('programmatic selection (kind=Command) does not clear the highlight', async () => {
        await vscode.commands.executeCommand('tsk.goToParent', 'e2e-graph-parent');
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(api.getNavigationHighlight(), 'highlight should be set before the test action');

        // Setting `editor.selection` directly fires onDidChangeTextEditorSelection
        // with kind=Command. The kind filter must ignore this — it's
        // indistinguishable from the navigate's own selection-set otherwise.
        const editor = vscode.window.activeTextEditor;
        assert.ok(editor);
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        await new Promise((resolve) => setImmediate(resolve));

        const highlight = api.getNavigationHighlight();
        assert.ok(highlight, 'highlight should survive a programmatic selection change');
    });

    test('a second navigate replaces the prior highlight', async () => {
        await vscode.commands.executeCommand('tsk.goToParent', 'e2e-graph-parent');
        await new Promise((resolve) => setImmediate(resolve));
        const first = api.getNavigationHighlight();
        assert.ok(first);

        // Navigate to a different target — the canonical e2e-dup occurrence.
        await vscode.commands.executeCommand('tsk.goToParent', 'e2e-dup');
        await new Promise((resolve) => setImmediate(resolve));

        const dup = api.lookupGraph('e2e-dup');
        assert.ok(dup);
        const second = api.getNavigationHighlight();
        assert.ok(second, 'highlight should still be active after the second navigate');
        assert.strictEqual(second.line, dup.line, 'highlight should land on the new target');
        assert.notStrictEqual(second.line, first.line, 'a different line than the first navigate');
    });

    test('switching active editor off the highlighted one clears the highlight', async () => {
        await vscode.commands.executeCommand('tsk.goToParent', 'e2e-graph-parent');
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(api.getNavigationHighlight());

        // Open a different .tsk file → active editor changes off dup.tsk →
        // listener clears the highlight.
        const sampleDoc = await vscode.workspace.openTextDocument(sampleUri);
        await vscode.window.showTextDocument(sampleDoc);
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(
            api.getNavigationHighlight(),
            undefined,
            'highlight should be cleared after the active editor moves off the highlighted one',
        );
    });
});
