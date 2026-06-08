import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';

/**
 * `tsk.moveTaskToFile` e2e. The command is interactive (a destination QuickPick,
 * and a save dialog for "New file…"), so each test STUBS `vscode.window`'s
 * pickers, runs the command on a real temp `.tsk` file in the workspace, asserts
 * the source + destination contents, then reverts + deletes the temp files.
 */
suite('move task to file', () => {
    let workspaceUri: vscode.Uri;
    const created: vscode.Uri[] = [];
    const win = vscode.window as unknown as {
        showQuickPick: unknown;
        showSaveDialog: unknown;
    };
    const origQuickPick = win.showQuickPick;
    const origSaveDialog = win.showSaveDialog;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'a workspace folder is required for this suite');
        workspaceUri = folder.uri;
    });

    teardown(async () => {
        win.showQuickPick = origQuickPick;
        win.showSaveDialog = origSaveDialog;
        // Revert dirty editors so closing doesn't prompt, then delete temp files.
        for (const uri of created.splice(0)) {
            try {
                await vscode.window.showTextDocument(uri);
                await vscode.commands.executeCommand('workbench.action.files.revert');
            } catch {
                /* not open */
            }
            try {
                await vscode.workspace.fs.delete(uri);
            } catch {
                /* already gone */
            }
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        // This is the only suite that creates real workspace files; reconcile the
        // cache to disk so a temp file can't leak into another suite's counts.
        await vscode.commands.executeCommand('tsk.rebuildCache');
    });

    async function writeFile(name: string, content: string): Promise<vscode.Uri> {
        const uri = vscode.Uri.joinPath(workspaceUri, name);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        created.push(uri);
        return uri;
    }

    async function cursorOn(uri: vscode.Uri, line: number): Promise<void> {
        const editor = await vscode.window.showTextDocument(
            await vscode.workspace.openTextDocument(uri),
        );
        editor.selections = [new vscode.Selection(line, 0, line, 0)];
        await new Promise((resolve) => setImmediate(resolve));
    }

    const SRC = [
        '- [ ] keep me <!-- @id:keep1 -->',
        '- [/] relocate me #proj <!-- @id:moveX @created:2026-01-01T00:00:00+00:00 -->',
        '  - [ ] child <!-- @id:childY -->',
        '- [ ] also keep <!-- @id:keep2 -->',
        '',
    ].join('\n');

    test('moves a task + its indented block to an existing file, leaving a [>] breadcrumb', async () => {
        const src = await writeFile('mv-src.tsk', SRC);
        const dst = await writeFile('mv-dst.tsk', '# destination\n');

        win.showQuickPick = async (items: ReadonlyArray<{ uri?: vscode.Uri }>) =>
            items.find((i) => i.uri?.toString() === dst.toString());

        await cursorOn(src, 1); // "relocate me"
        await vscode.commands.executeCommand('tsk.moveTaskToFile');

        const srcText = (await vscode.workspace.openTextDocument(src)).getText();
        const dstText = (await vscode.workspace.openTextDocument(dst)).getText();

        // Source: the task line is now a [>] breadcrumb — fresh @id, @movedTo:moveX,
        // tags stripped; the child moved out; siblings remain.
        assert.match(
            srcText,
            /- \[>\] relocate me <!-- @id:[a-z0-9]+ @movedTo:moveX @moved:[\d\-T:+]+ -->/,
        );
        assert.ok(!srcText.includes('@id:childY'), 'child should have left the source');
        assert.ok(srcText.includes('@id:keep1'), 'sibling above stays');
        assert.ok(srcText.includes('@id:keep2'), 'sibling below stays');

        // Destination: the relocated task keeps its @id + tags + @created (verbatim),
        // and its child rode along.
        assert.match(dstText, /- \[\/\] relocate me #proj <!-- @id:moveX @created:[\d\-T:+]+ -->/);
        assert.match(dstText, / {2}- \[ \] child <!-- @id:childY -->/);
    });

    test('moves to a newly-created file via the save dialog', async () => {
        const src = await writeFile('mv-src2.tsk', SRC);
        const newUri = vscode.Uri.joinPath(workspaceUri, 'mv-new.tsk');
        created.push(newUri); // ensure cleanup even though we didn't writeFile it

        win.showQuickPick = async (items: ReadonlyArray<{ newFile?: boolean }>) =>
            items.find((i) => i.newFile);
        win.showSaveDialog = async () => newUri;

        await cursorOn(src, 1);
        await vscode.commands.executeCommand('tsk.moveTaskToFile');

        const newText = (await vscode.workspace.openTextDocument(newUri)).getText();
        assert.match(newText, /- \[\/\] relocate me #proj <!-- @id:moveX @created:[\d\-T:+]+ -->/);
        assert.match(newText, / {2}- \[ \] child <!-- @id:childY -->/);
    });

    test('rejects a task with no @id (no move, no picker)', async () => {
        const src = await writeFile('mv-noid.tsk', '- [ ] no id here\n');
        let pickerCalled = false;
        win.showQuickPick = async () => {
            pickerCalled = true;
            return undefined;
        };

        await cursorOn(src, 0);
        await vscode.commands.executeCommand('tsk.moveTaskToFile');

        assert.strictEqual(pickerCalled, false, 'the destination picker should not open');
        assert.strictEqual(
            (await vscode.workspace.openTextDocument(src)).getText(),
            '- [ ] no id here\n',
            'the source is untouched',
        );
    });
});
