import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';

/**
 * `tsk.markNow` (Alt+W) e2e (M45). Drives the command against untitled `.tsk`
 * docs (so it doesn't perturb the workspace-fixture cache counts) and asserts
 * the now-tree + the persistent decoration via the test API getters — the only
 * way to read decoration state, which VSCode doesn't expose directly.
 *
 * The now-store is a single in-memory instance (the fixture sets
 * `tsk.state.path: ""`), so marks accumulate across tests; assertions are
 * therefore current-focused (`getNowTaskId` / the tree's `currentEntryId`),
 * which the accumulation doesn't disturb. The richer tree-operation coverage
 * (switch / prune / persistence) lives in the now-tree + now-store unit suites.
 */
suite('mark-now (M45)', () => {
    let api: TskExtensionApi;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();
    });

    setup(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await new Promise((resolve) => setImmediate(resolve));
    });

    /** Open an untitled `.tsk` doc with `content`, put the cursor on `line`, run Alt+W. */
    async function markNow(content: string, line = 0): Promise<vscode.TextDocument> {
        const doc = await vscode.workspace.openTextDocument({ content, language: 'tsk' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selections = [new vscode.Selection(line, 0, line, 0)];
        await new Promise((resolve) => setImmediate(resolve));
        await vscode.commands.executeCommand('tsk.markNow');
        await new Promise((resolve) => setImmediate(resolve));
        return doc;
    }

    test('stamps @id, sets [/], becomes the current now, and decorates the line', async () => {
        const doc = await markNow('- [ ] write the spec');

        const line = doc.lineAt(0).text;
        assert.match(
            line,
            /^- \[\/\] write the spec <!-- @id:[a-z0-9]+ @created:[\d\-T:+]+ -->$/,
            'should stamp @id + @created and set the [/] marker',
        );
        const id = /@id:([a-z0-9]+)/.exec(line)?.[1];
        assert.ok(id);

        assert.strictEqual(api.getNowTaskId(), id, 'the stamped id is the current now');
        const tree = api.getNowTree();
        const current = tree.entries.find((e) => e.entryId === tree.currentEntryId);
        assert.strictEqual(current?.id, id, 'the current tree node points at the marked task');

        const deco = api.getNowDecoration();
        assert.ok(deco, 'a now-decoration should be painted on the visible task');
        assert.strictEqual(deco.uri, doc.uri.toString());
        assert.strictEqual(deco.line, 0);
    });

    test('marking a second task moves the current now (child of the first) and the decoration', async () => {
        await markNow('- [ ] first task <!-- @id:m45-first -->');
        assert.strictEqual(api.getNowTaskId(), 'm45-first');

        const doc = await markNow('- [ ] second task <!-- @id:m45-second -->');
        assert.strictEqual(api.getNowTaskId(), 'm45-second', 'current advances to the new mark');

        const tree = api.getNowTree();
        const current = tree.entries.find((e) => e.entryId === tree.currentEntryId);
        assert.strictEqual(current?.id, 'm45-second');
        const parent = tree.entries.find((e) => e.entryId === current?.parentId);
        assert.strictEqual(parent?.id, 'm45-first', 'the new now is a child of the previous now');

        const deco = api.getNowDecoration();
        assert.ok(deco);
        assert.strictEqual(deco.uri, doc.uri.toString(), 'decoration follows the current now');
        assert.strictEqual(deco.line, 0);
    });

    test('marking a non-task line is a no-op (no file edit, current unchanged)', async () => {
        await markNow('- [ ] a real task <!-- @id:m45-real -->');
        assert.strictEqual(api.getNowTaskId(), 'm45-real');

        const doc = await markNow('just some prose, not a task');
        assert.strictEqual(
            doc.lineAt(0).text,
            'just some prose, not a task',
            'a non-task line must not be edited',
        );
        assert.strictEqual(api.getNowTaskId(), 'm45-real', 'the current now must be unchanged');
    });

    test('contributes Alt+W → tsk.markNow, gated to tsk editors', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const keybindings = ext.packageJSON.contributes.keybindings as ReadonlyArray<{
            command: string;
            key: string;
            when: string;
        }>;
        const kb = keybindings.find((k) => k.command === 'tsk.markNow');
        assert.ok(kb, 'expected a keybinding for tsk.markNow');
        assert.strictEqual(kb.key, 'alt+w');
        assert.strictEqual(kb.when, "editorLangId == 'tsk' && editorTextFocus");
    });

    test('tsk.now.openStack opens the Now Stack panel without throwing', async () => {
        // Smoke: createWebviewPanel + the nonce/CSP HTML build cleanly. The React
        // mount, the message bridge, and "Move into a New Window" are dev-host
        // (manual) checks — the webview DOM isn't reachable from the e2e API.
        await vscode.commands.executeCommand('tsk.now.openStack');
        await new Promise((resolve) => setImmediate(resolve));

        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const commands = ext.packageJSON.contributes.commands as ReadonlyArray<{ command: string }>;
        assert.ok(
            commands.some((c) => c.command === 'tsk.now.openStack'),
            'tsk.now.openStack should be contributed',
        );
    });
});
