import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Priority-toggle e2e. Untitled docs keep the cache clean (see the M5/B
 * fix in `extension.ts` that excludes `doc.isUntitled` from cache rescan).
 */
suite('toggle priority commands', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
    });

    async function runToggle(content: string, commandId: string, cursorLine = 0): Promise<string> {
        const doc = await vscode.workspace.openTextDocument({ content, language: 'tsk' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(cursorLine, 0, cursorLine, 0);
        await new Promise((resolve) => setImmediate(resolve));
        await vscode.commands.executeCommand(commandId);
        return doc.lineAt(cursorLine).text;
    }

    test('toggleP1 adds @priority:1 to a task', async () => {
        const line = await runToggle('- [ ] thing', 'tsk.toggleP1');
        assert.strictEqual(line, '- [ ] thing <!-- @priority:1 -->');
    });

    test('toggleP2 on a P1 line clears P1 and adds P2 (mutual exclusion)', async () => {
        const line = await runToggle('- [ ] x <!-- @priority:1 -->', 'tsk.toggleP2');
        assert.strictEqual(line, '- [ ] x <!-- @priority:2 -->');
    });

    test('contributes.keybindings registers Alt+1/2/3 gated to tsk', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const keybindings = ext.packageJSON.contributes.keybindings as ReadonlyArray<{
            command: string;
            key: string;
            when: string;
        }>;
        const expected = [
            { command: 'tsk.toggleP1', key: 'alt+1' },
            { command: 'tsk.toggleP2', key: 'alt+2' },
            { command: 'tsk.toggleP3', key: 'alt+3' },
        ];
        for (const exp of expected) {
            const found = keybindings.find((k) => k.command === exp.command);
            assert.ok(found, `expected keybinding for ${exp.command}`);
            assert.strictEqual(found.key, exp.key);
            assert.strictEqual(found.when, "editorLangId == 'tsk'");
        }
    });
});
