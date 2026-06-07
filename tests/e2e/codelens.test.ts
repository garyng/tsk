import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';
import { CODICONS } from '../../src/lib/codelens-logic';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Codelens e2e. Uses the `dup.tsk` fixture's parent→child edge — line
 * 8 (zero-indexed: `- [ ] parent task <!-- @id:e2e-graph-parent -->`)
 * carries the `children: 1` inverse lens; line 9 (`- [ ] child task
 * <!-- @id:e2e-graph-child @parent:e2e-graph-parent -->`) carries the
 * `parent: e2e-graph-parent` forward lens.
 *
 * Pure lens computation is covered exhaustively in
 * `src/lib/codelens-logic.test.ts`; this suite verifies that the
 * activation layer wires the provider + the navigate/peek/missing
 * commands correctly through the real VSCode host.
 */
suite('codelens', () => {
    let api: TskExtensionApi;
    let dupUri: vscode.Uri;
    let movedUri: vscode.Uri;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();

        const firstFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(firstFolder, 'expected a workspace folder');
        dupUri = vscode.Uri.joinPath(firstFolder.uri, 'dup.tsk');
        movedUri = vscode.Uri.joinPath(firstFolder.uri, 'moved.tsk');
        // Touch the API so the unused-variable lint doesn't trip when
        // we add more reliance later.
        void api;
    });

    test('all eight navigate/peek commands + the missing handler are registered', async () => {
        const registered = await vscode.commands.getCommands(true);
        for (const command of [
            'tsk.goToParent',
            'tsk.goToDependsOn',
            'tsk.goToRelated',
            'tsk.goToMovedTo',
            'tsk.findAllChildren',
            'tsk.findAllDependents',
            'tsk.findAllRelated',
            'tsk.findAllMovedHereFrom',
            'tsk.codelens.missing',
        ]) {
            assert.ok(registered.includes(command), `${command} should be registered`);
        }
    });

    test('lenses appear on the canonical parent task and its child', async () => {
        const doc = await vscode.workspace.openTextDocument(dupUri);
        await vscode.window.showTextDocument(doc);
        const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
            'vscode.executeCodeLensProvider',
            dupUri,
        );
        assert.ok(lenses, 'codelens provider returned lenses');
        const byTitle = new Map(lenses.map((l) => [l.command?.title, l]));

        const childrenLens = byTitle.get(`$(${CODICONS.children}) children: 1`);
        assert.ok(
            childrenLens,
            'parent task should expose `children: 1` with its configured codicon prefix',
        );
        assert.strictEqual(childrenLens.command?.command, 'tsk.findAllChildren');

        const parentLens = byTitle.get(`$(${CODICONS.parent}) parent: e2e-graph-parent`);
        assert.ok(
            parentLens,
            'child task should expose `parent: e2e-graph-parent` with its configured codicon prefix',
        );
        assert.strictEqual(parentLens.command?.command, 'tsk.goToParent');
        assert.deepStrictEqual(parentLens.command?.arguments, ['e2e-graph-parent']);
    });

    test('tsk.goToParent opens the parent file at the parent line', async () => {
        // Close any open editors so the active-editor check below is meaningful.
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await new Promise((resolve) => setImmediate(resolve));

        await vscode.commands.executeCommand('tsk.goToParent', 'e2e-graph-parent');
        await new Promise((resolve) => setImmediate(resolve));

        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, 'navigate should leave an editor active');
        assert.strictEqual(editor.document.uri.toString(), dupUri.toString());

        const parentNode = api.lookupGraph('e2e-graph-parent');
        assert.ok(parentNode);
        assert.strictEqual(editor.selection.active.line, parentNode.line);
    });

    test('tsk.goToParent on a missing id pops an info message (no editor change)', async () => {
        // We can't directly intercept showInformationMessage, but we *can*
        // assert no exception fires and the active editor is unchanged.
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await new Promise((resolve) => setImmediate(resolve));
        const before = vscode.window.activeTextEditor;
        await vscode.commands.executeCommand('tsk.goToParent', 'does-not-exist');
        await new Promise((resolve) => setImmediate(resolve));
        const after = vscode.window.activeTextEditor;
        assert.strictEqual(
            before,
            after,
            'missing-id navigate should not change the active editor',
        );
    });

    test('movedTo lenses: forward codicon for a real target, (missing) for a dangling one', async () => {
        const doc = await vscode.workspace.openTextDocument(movedUri);
        await vscode.window.showTextDocument(doc);
        const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
            'vscode.executeCodeLensProvider',
            movedUri,
        );
        assert.ok(lenses, 'codelens provider returned lenses');
        const byTitle = new Map(lenses.map((l) => [l.command?.title, l]));

        const movedLens = byTitle.get(`$(${CODICONS.movedTo}) movedTo: e2e-moved-target`);
        assert.ok(movedLens, 'moved task should expose `movedTo: e2e-moved-target`');
        assert.strictEqual(movedLens.command?.command, 'tsk.goToMovedTo');
        assert.deepStrictEqual(movedLens.command?.arguments, ['e2e-moved-target']);

        const missingLens = byTitle.get(`$(${CODICONS.missing}) movedTo: e2e-moved-gone (missing)`);
        assert.ok(missingLens, 'dangling movedTo should render the (missing) lens');
        assert.strictEqual(missingLens.command?.command, 'tsk.codelens.missing');
        assert.deepStrictEqual(missingLens.command?.arguments, ['e2e-moved-gone', 'movedTo']);

        // M8 — the move target now carries the inverse "moved here from" lens.
        const movedHereLens = byTitle.get(`$(${CODICONS.movedHereFrom}) movedHereFrom: 1`);
        assert.ok(movedHereLens, 'move target should expose the `movedHereFrom: 1` inverse lens');
        assert.strictEqual(movedHereLens.command?.command, 'tsk.findAllMovedHereFrom');
        assert.deepStrictEqual(movedHereLens.command?.arguments?.[2], ['e2e-moved-src']);
    });

    test('tsk.goToMovedTo opens the target file at the target line', async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await new Promise((resolve) => setImmediate(resolve));

        await vscode.commands.executeCommand('tsk.goToMovedTo', 'e2e-moved-target');
        await new Promise((resolve) => setImmediate(resolve));

        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, 'navigate should leave an editor active');
        assert.strictEqual(editor.document.uri.toString(), movedUri.toString());

        const targetNode = api.lookupGraph('e2e-moved-target');
        assert.ok(targetNode);
        assert.strictEqual(editor.selection.active.line, targetNode.line);
    });
});
