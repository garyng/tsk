import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';

suite('activation', () => {
    test('extension activates when a .tsk document is opened', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);

        const doc = await vscode.workspace.openTextDocument({
            language: 'tsk',
            content: '- [ ] hello world\n',
        });
        await vscode.window.showTextDocument(doc);
        await ext.activate();

        assert.strictEqual(ext.isActive, true, 'extension should be active after .tsk open');
        assert.strictEqual(doc.languageId, 'tsk', 'document should be recognised as tsk');
    });

    test('contributed commands are registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(
            commands.includes('tsk.rebuildCache'),
            'tsk.rebuildCache should appear in the command list',
        );
    });

    test('contributed configuration is queryable with defaults', () => {
        const config = vscode.workspace.getConfiguration('tsk');
        assert.strictEqual(config.get<string>('log.level'), 'info');
        assert.strictEqual(config.get<number>('decorations.priority.opacity'), 0.15);
        assert.strictEqual(config.get<number>('editor.changeDebounceMs'), 300);
    });
});
