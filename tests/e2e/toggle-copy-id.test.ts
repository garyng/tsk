import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';

/**
 * `tsk.copyTaskId` e2e: verifies the command reads `@id` off the current
 * task line and writes it to the system clipboard. The no-id case is
 * checked indirectly — we plant a sentinel value in the clipboard first,
 * then assert the sentinel survives because the command bailed without
 * writing.
 */
suite('tsk.copyTaskId', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
    });

    test('copies the @id from the task on the cursor line to the clipboard', async () => {
        const doc = await vscode.workspace.openTextDocument({
            content: '- [ ] something <!-- @id:m5copyid -->',
            language: 'tsk',
        });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        await new Promise((resolve) => setImmediate(resolve));

        await vscode.env.clipboard.writeText('sentinel-before');
        await vscode.commands.executeCommand('tsk.copyTaskId');
        assert.strictEqual(await vscode.env.clipboard.readText(), 'm5copyid');
    });

    test('does not change the clipboard when the task has no @id', async () => {
        const doc = await vscode.workspace.openTextDocument({
            content: '- [ ] no id here',
            language: 'tsk',
        });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        await new Promise((resolve) => setImmediate(resolve));

        await vscode.env.clipboard.writeText('sentinel-noid');
        await vscode.commands.executeCommand('tsk.copyTaskId');
        assert.strictEqual(await vscode.env.clipboard.readText(), 'sentinel-noid');
    });

    test('contributes.keybindings registers Alt+` for copyTaskId', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const keybindings = ext.packageJSON.contributes.keybindings as ReadonlyArray<{
            command: string;
            key: string;
            when: string;
        }>;
        const found = keybindings.find((k) => k.command === 'tsk.copyTaskId');
        assert.ok(found, 'expected keybinding for tsk.copyTaskId');
        assert.strictEqual(found.key, 'alt+`');
        assert.strictEqual(found.when, "editorLangId == 'tsk'");
    });
});
