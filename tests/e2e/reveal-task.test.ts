import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';

/**
 * `tsk.revealTask` and the `vscode://garyng.tsk/open?id=<id>` URI handler
 * against the `sample.tsk` fixture. The handler is driven through the API:
 * the test host can't be relied on to route an outside `vscode://` URI back
 * to itself.
 */
suite('reveal a task by id', () => {
    let api: TskExtensionApi;
    let sampleUri: vscode.Uri;

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
        await new Promise((resolve) => setImmediate(resolve));
    });

    function assertLandedOn(id: string): void {
        const task = api.findTaskById(id);
        assert.ok(task, `fixture should hold @id:${id}`);
        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, 'expected an editor');
        assert.strictEqual(editor.document.uri.toString(), sampleUri.toString());
        assert.strictEqual(editor.selection.active.line, task.line);
        assert.deepStrictEqual(api.getNavigationHighlight(), {
            uri: sampleUri.toString(),
            line: task.line,
        });
    }

    test('the command opens the task’s file at its line, highlighted', async () => {
        const revealed = await vscode.commands.executeCommand('tsk.revealTask', 'm3task3');
        assert.strictEqual(revealed, true);
        assertLandedOn('m3task3');
    });

    test('the command takes a tsk:<id> as a plan writes it', async () => {
        await vscode.commands.executeCommand('tsk.revealTask', 'tsk:m3task2');
        assertLandedOn('m3task2');
    });

    test('an unknown id opens nothing', async () => {
        const revealed = await vscode.commands.executeCommand('tsk.revealTask', 'nosuchid');
        assert.strictEqual(revealed, false);
        assert.strictEqual(vscode.window.activeTextEditor, undefined);
    });

    test('the URI handler reveals the task /open?id= names', async () => {
        await api.openTaskUri(`${vscode.env.uriScheme}://${EXTENSION_ID}/open?id=m3task1`);
        assertLandedOn('m3task1');
    });

    test('the URI handler opens nothing for another path', async () => {
        await api.openTaskUri(`${vscode.env.uriScheme}://${EXTENSION_ID}/show?id=m3task1`);
        assert.strictEqual(vscode.window.activeTextEditor, undefined);
    });
});
