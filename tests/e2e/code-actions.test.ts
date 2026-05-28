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
});
