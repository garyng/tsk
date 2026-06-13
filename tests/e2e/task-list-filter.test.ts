import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';

/**
 * The "Current file" task-list filter compares `row.fileUri === activeFile.uri`,
 * where `row.fileUri` is the cache's stored URI and `activeFile.uri` is the host
 * posting `editor.document.uri.toString()`. For the filter to ever match, those
 * two must be the *identical* canonical string — this pins that invariant against
 * the fixture's `sample.tsk` (the client-side filtering + toggle UI is covered by
 * the webview golden in M2).
 */
suite('task-list — current-file filter key', () => {
    let api: TskExtensionApi;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();
    });

    test("a task's cached fileUri equals its editor document.uri.toString()", async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'fixture workspace folder should be mounted');
        const sampleUri = vscode.Uri.joinPath(folder.uri, 'sample.tsk');
        const doc = await vscode.workspace.openTextDocument(sampleUri);
        await vscode.window.showTextDocument(doc);

        const task = api.findTaskById('m3task1');
        assert.ok(task, 'fixture task m3task1 should be indexed');
        assert.strictEqual(
            task.fileUri,
            doc.uri.toString(),
            'cache fileUri must equal the active editor URI, or the filter never matches',
        );
    });
});
