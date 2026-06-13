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

    test('undo of a move to a new file is atomic — no leftover duplicate @id', async () => {
        const src = await writeFile('mv-src3.tsk', SRC);
        const newUri = vscode.Uri.joinPath(workspaceUri, 'mv-new2.tsk');
        created.push(newUri);

        win.showQuickPick = async (items: ReadonlyArray<{ newFile?: boolean }>) =>
            items.find((i) => i.newFile);
        win.showSaveDialog = async () => newUri;

        await cursorOn(src, 1);
        await vscode.commands.executeCommand('tsk.moveTaskToFile');
        assert.ok(
            (await vscode.workspace.openTextDocument(newUri)).getText().includes('@id:moveX'),
            'precondition: the task moved into the new file',
        );

        // One undo must revert the whole bulk edit: source restored, new file gone.
        // A split undo (createFile + separate insert) would leave @id:moveX in BOTH.
        await vscode.commands.executeCommand('undo');
        await new Promise((resolve) => setImmediate(resolve));

        const srcText = (await vscode.workspace.openTextDocument(src)).getText();
        assert.ok(srcText.includes('@id:moveX'), 'the original task is restored in the source');
        assert.ok(!srcText.includes('@movedTo:moveX'), 'the breadcrumb was undone');

        let newText = '';
        try {
            newText = (await vscode.workspace.openTextDocument(newUri)).getText();
        } catch {
            /* the undo removed the file — also fine */
        }
        assert.ok(
            !newText.includes('@id:moveX'),
            'the new file no longer holds the task, so @id:moveX is not duplicated',
        );
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

    // ── Extract: move with no breadcrumb (the source block is deleted) ────────

    test('extracts a task to an existing file — source block removed, no breadcrumb', async () => {
        const src = await writeFile('ex-src.tsk', SRC);
        const dst = await writeFile('ex-dst.tsk', '# destination\n');
        win.showQuickPick = async (items: ReadonlyArray<{ uri?: vscode.Uri }>) =>
            items.find((i) => i.uri?.toString() === dst.toString());

        await cursorOn(src, 1); // "relocate me"
        await vscode.commands.executeCommand('tsk.extractTaskToFile');

        const srcText = (await vscode.workspace.openTextDocument(src)).getText();
        assert.ok(!srcText.includes('relocate me'), 'the task line is gone');
        assert.ok(!srcText.includes('@id:childY'), 'its child left too');
        assert.ok(
            !srcText.includes('[>]') && !srcText.includes('@movedTo'),
            'no [>] breadcrumb is left behind',
        );
        assert.ok(srcText.includes('@id:keep1') && srcText.includes('@id:keep2'), 'siblings stay');
        assert.match(
            srcText,
            /keep me[^\n]*\n- \[ \] also keep/,
            'siblings are adjacent — no orphan blank line where the block was',
        );

        const dstText = (await vscode.workspace.openTextDocument(dst)).getText();
        assert.match(dstText, /- \[\/\] relocate me #proj <!-- @id:moveX @created:[\d\-T:+]+ -->/);
        assert.match(dstText, / {2}- \[ \] child <!-- @id:childY -->/);
    });

    test('extracting a block at end-of-file leaves no orphan blank line', async () => {
        const src = await writeFile(
            'ex-eof.tsk',
            '- [ ] keep <!-- @id:ex-keep -->\n- [/] last <!-- @id:ex-last -->',
        );
        const dst = await writeFile('ex-eof-dst.tsk', '# d\n');
        win.showQuickPick = async (items: ReadonlyArray<{ uri?: vscode.Uri }>) =>
            items.find((i) => i.uri?.toString() === dst.toString());

        await cursorOn(src, 1);
        await vscode.commands.executeCommand('tsk.extractTaskToFile');

        assert.strictEqual(
            (await vscode.workspace.openTextDocument(src)).getText(),
            '- [ ] keep <!-- @id:ex-keep -->',
            'only the kept line remains — the preceding newline was consumed, no trailing blank',
        );
    });

    test('extracts from markdown — raw md children convert, original deleted, no breadcrumb', async () => {
        const src = await writeFile(
            'ex-md.md',
            '- [x] parent <!-- @id:ex-mdtop -->\n    - [/] child done\n- [ ] stay\n',
        );
        const dst = await writeFile('ex-md-dst.tsk', '# d\n');
        win.showQuickPick = async (items: ReadonlyArray<{ uri?: vscode.Uri }>) =>
            items.find((i) => i.uri?.toString() === dst.toString());

        await cursorOn(src, 0);
        await vscode.commands.executeCommand('tsk.extractTaskToFile');

        const srcText = (await vscode.workspace.openTextDocument(src)).getText();
        assert.ok(!srcText.includes('parent') && !srcText.includes('child done'), 'block removed');
        assert.ok(!srcText.includes('[>]') && !srcText.includes('@movedTo'), 'no breadcrumb');
        assert.strictEqual(srcText.split('\n')[0], '- [ ] stay', 'the sibling stays');

        const dstText = (await vscode.workspace.openTextDocument(dst)).getText();
        assert.ok(dstText.includes('- [x] parent <!-- @id:ex-mdtop -->'), 'parent moved verbatim');
        assert.match(
            dstText,
            / {4}- \[x\] child done <!-- @id:[a-z0-9]+ @created:[\d\-T:+]+ @completed:[\d\-T:+]+ -->/,
            'the raw md-done child (md [/]) converted to tsk [x] on the way out',
        );
    });

    test('offers Move and Extract on an id-carrying line, neither on an id-less line', async () => {
        const src = await writeFile(
            'ex-actions.tsk',
            '- [ ] has <!-- @id:ex-act -->\n- [ ] none\n',
        );
        await cursorOn(src, 0); // the doc must be open for the code-action provider query
        const onId = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider',
            src,
            new vscode.Range(0, 0, 0, 0),
        );
        const idTitles = (onId ?? []).map((a) => a.title);
        assert.ok(
            idTitles.includes('Move task to file…') && idTitles.includes('Extract task to file…'),
            'both Move and Extract are offered on an @id task line',
        );
        const onNone = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider',
            src,
            new vscode.Range(1, 0, 1, 0),
        );
        assert.ok(
            !(onNone ?? []).some((a) => a.title === 'Extract task to file…'),
            'an id-less line offers no Extract',
        );
    });
});
