import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Relationship-toggle e2e. Add-mode opens a `vscode.window.createInputBox`
 * — driving that from `@vscode/test-cli` would require simulating key
 * presses, which is brittle, so add-mode is validated manually via the
 * dev host. The deterministic *remove* mode (when the metadata key is
 * already present) doesn't open the picker and is fair game for e2e.
 */
suite('toggle relationship + moved commands', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
    });

    async function runOnLine(content: string, commandId: string): Promise<string> {
        const doc = await vscode.workspace.openTextDocument({ content, language: 'tsk' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        await new Promise((resolve) => setImmediate(resolve));
        await vscode.commands.executeCommand(commandId);
        return doc.lineAt(0).text;
    }

    test('toggleRelatedTo removes @relatedTo when present (no picker)', async () => {
        const line = await runOnLine(
            '- [ ] thing <!-- @relatedTo:abc123 -->',
            'tsk.toggleRelatedTo',
        );
        assert.strictEqual(line, '- [ ] thing');
    });

    test('toggleDependsOn removes @dependsOn when present (no picker)', async () => {
        const line = await runOnLine(
            '- [ ] thing <!-- @dependsOn:abc123 -->',
            'tsk.toggleDependsOn',
        );
        assert.strictEqual(line, '- [ ] thing');
    });

    test('toggleParent removes @parent when present (no picker)', async () => {
        const line = await runOnLine('- [ ] thing <!-- @parent:abc123 -->', 'tsk.toggleParent');
        assert.strictEqual(line, '- [ ] thing');
    });

    test('toggleMoved on a moved task swaps to todo and clears @movedTo + @moved', async () => {
        const line = await runOnLine(
            '- [>] thing <!-- @movedTo:abc123 @moved:2026-05-25T09:00:00+08:00 -->',
            'tsk.toggleMoved',
        );
        assert.strictEqual(line, '- [ ] thing');
    });

    test('contributes.commands registers all four picker-driven commands', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const commands = ext.packageJSON.contributes.commands as ReadonlyArray<{
            command: string;
        }>;
        for (const id of [
            'tsk.toggleMoved',
            'tsk.toggleRelatedTo',
            'tsk.toggleDependsOn',
            'tsk.toggleParent',
        ]) {
            assert.ok(
                commands.some((c) => c.command === id),
                `expected ${id} in contributes.commands`,
            );
        }
    });

    test('contributes.keybindings registers Alt+M/R/D/P gated to tsk', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const keybindings = ext.packageJSON.contributes.keybindings as ReadonlyArray<{
            command: string;
            key: string;
            when: string;
        }>;
        const expected = [
            { command: 'tsk.toggleMoved', key: 'alt+m' },
            { command: 'tsk.toggleRelatedTo', key: 'alt+r' },
            { command: 'tsk.toggleDependsOn', key: 'alt+d' },
            { command: 'tsk.toggleParent', key: 'alt+p' },
        ];
        for (const exp of expected) {
            const found = keybindings.find((k) => k.command === exp.command);
            assert.ok(found, `expected keybinding for ${exp.command}`);
            assert.strictEqual(found.key, exp.key);
            assert.strictEqual(found.when, "editorLangId == 'tsk'");
        }
    });
});
