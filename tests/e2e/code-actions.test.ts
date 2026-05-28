import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Code-action e2e suite (M19/C). Each test opens an untitled `.tsk`
 * buffer, places the cursor on a target line, asks VS Code for the
 * QuickFix actions at that location, and asserts the provider's
 * behavior: title (varies by which fields are missing), edit (matches
 * the M19/A promote rule), and apply-effect.
 */
suite('code actions — Add missing id + created', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
    });

    async function actionsAt(content: string, line: number): Promise<vscode.CodeAction[]> {
        const doc = await vscode.workspace.openTextDocument({ content, language: 'tsk' });
        await vscode.window.showTextDocument(doc);
        const range = new vscode.Range(line, 0, line, 0);
        const result = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider',
            doc.uri,
            range,
            vscode.CodeActionKind.QuickFix.value,
        );
        return result ?? [];
    }

    test('surfaces "Add missing id + created" on a no-metadata todo', async () => {
        const actions = await actionsAt('- [ ] needs id', 0);
        const ours = actions.find((a) => a.title.startsWith('Tsk:'));
        assert.ok(ours, 'expected a Tsk code action');
        assert.strictEqual(ours.title, 'Tsk: Add missing id + created');
        assert.strictEqual(ours.kind?.value, vscode.CodeActionKind.QuickFix.value);
    });

    test('surfaces "Add missing id" (only) when @created is already present', async () => {
        const actions = await actionsAt(
            '- [ ] partial <!-- @created:2026-01-01T00:00:00+08:00 -->',
            0,
        );
        const ours = actions.find((a) => a.title.startsWith('Tsk:'));
        assert.ok(ours, 'expected a Tsk code action');
        assert.strictEqual(ours.title, 'Tsk: Add missing id');
    });

    test('does NOT surface on a task that already has @id', async () => {
        const actions = await actionsAt('- [ ] done <!-- @id:abc -->', 0);
        const ours = actions.find((a) => a.title.startsWith('Tsk:'));
        assert.strictEqual(ours, undefined, 'no Tsk action should appear when @id exists');
    });

    test('does NOT surface on a plain (non-task) line', async () => {
        const actions = await actionsAt('just a paragraph', 0);
        const ours = actions.find((a) => a.title.startsWith('Tsk:'));
        assert.strictEqual(ours, undefined, 'no Tsk action should appear on a non-task line');
    });

    test('is marker-agnostic — surfaces on a [x] completed task with no @id', async () => {
        // The Alt+A toggle mutator is gated to the todo marker; the code
        // action is more permissive so a hand-typed `- [x] done` can be
        // promoted in place without first cycling markers.
        const actions = await actionsAt('- [x] done', 0);
        const ours = actions.find((a) => a.title.startsWith('Tsk:'));
        assert.ok(ours, 'expected a Tsk code action on a [x] task without @id');
        assert.strictEqual(ours.title, 'Tsk: Add missing id + created');
    });

    test('applying the action rewrites the line with @id + @created', async () => {
        const doc = await vscode.workspace.openTextDocument({
            content: '- [ ] needs id',
            language: 'tsk',
        });
        await vscode.window.showTextDocument(doc);
        const range = new vscode.Range(0, 0, 0, 0);
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider',
            doc.uri,
            range,
            vscode.CodeActionKind.QuickFix.value,
        );
        const ours = (actions ?? []).find((a) => a.title.startsWith('Tsk:'));
        assert.ok(ours?.edit, 'expected a WorkspaceEdit on the action');
        await vscode.workspace.applyEdit(ours.edit);
        const after = doc.lineAt(0).text;
        assert.match(after, /^- \[ \] needs id <!-- @id:[a-z0-9]+ @created:[\d\-T:+]+ -->$/);
    });

    test('surfaces "Remove broken @parent" and "Replace @parent via picker…" on a broken-ref diagnostic', async () => {
        // Lean on the M20/B `broken-ref.tsk` fixture — its first task has a
        // broken @parent (ghost id).
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder);
        const brokenUri = vscode.Uri.joinPath(folder.uri, 'broken-ref.tsk');
        const doc = await vscode.workspace.openTextDocument(brokenUri);
        await vscode.window.showTextDocument(doc);
        // Give the graph time to index + emit the diagnostic.
        await new Promise((resolve) => setTimeout(resolve, 100));

        const diagnostics = vscode.languages.getDiagnostics(brokenUri).filter((d) => {
            return typeof d.code === 'string' && d.code === 'broken-ref:parent';
        });
        const parentDiag = diagnostics.find((d) => d.message.includes('m20-ghost-parent'));
        assert.ok(parentDiag, 'expected a broken-ref:parent diagnostic on the fixture');

        // Code-action request needs the matching diagnostic in its context.
        const orphanLine = parentDiag.range.start.line;
        const range = new vscode.Range(orphanLine, 0, orphanLine, 0);
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider',
            brokenUri,
            range,
            vscode.CodeActionKind.QuickFix.value,
        );
        const titles = (actions ?? []).map((a) => a.title);
        assert.ok(
            titles.includes('Tsk: Remove broken @parent'),
            `expected Remove action; got: ${titles.join(', ')}`,
        );
        assert.ok(
            titles.includes('Tsk: Replace @parent via picker…'),
            `expected Replace action; got: ${titles.join(', ')}`,
        );

        const remove = (actions ?? []).find((a) => a.title === 'Tsk: Remove broken @parent');
        assert.ok(remove?.edit, 'Remove action should carry a precomputed WorkspaceEdit');

        const replace = (actions ?? []).find((a) => a.title === 'Tsk: Replace @parent via picker…');
        assert.ok(replace?.command, 'Replace action should be backed by a command');
        assert.strictEqual(replace.command.command, 'tsk.replaceBrokenReference');
        assert.deepStrictEqual(replace.command.arguments?.[2], 'parent');
    });

    test('applying the Remove action drops the @parent entry from the line', async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder);
        const brokenUri = vscode.Uri.joinPath(folder.uri, 'broken-ref.tsk');
        const doc = await vscode.workspace.openTextDocument(brokenUri);
        await vscode.window.showTextDocument(doc);
        await new Promise((resolve) => setTimeout(resolve, 100));

        const diagnostics = vscode.languages
            .getDiagnostics(brokenUri)
            .filter((d) => typeof d.code === 'string' && d.message.includes('m20-ghost-parent'));
        const parentDiag = diagnostics[0];
        assert.ok(parentDiag);

        const orphanLine = parentDiag.range.start.line;
        const range = new vscode.Range(orphanLine, 0, orphanLine, 0);
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider',
            brokenUri,
            range,
            vscode.CodeActionKind.QuickFix.value,
        );
        const remove = (actions ?? []).find((a) => a.title === 'Tsk: Remove broken @parent');
        assert.ok(remove?.edit);
        await vscode.workspace.applyEdit(remove.edit);
        const after = doc.lineAt(orphanLine).text;
        assert.ok(!after.includes('@parent'), `expected @parent removed; line is now: ${after}`);
        // Undo so the file fixture isn't dirtied for the next test run.
        await vscode.commands.executeCommand('undo');
    });
});
