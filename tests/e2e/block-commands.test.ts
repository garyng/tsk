import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Task-block convenience gestures e2e. `tsk.copyTaskBlock` / `tsk.cutTaskBlock`
 * shadow VS Code's copy/cut in `.tsk` files: with nothing selected and a single
 * cursor on a task line, the whole block (task + indented sub-items) goes to the
 * clipboard; every other case defers to the native action. Untitled `.tsk` docs
 * (EOL `\n`), so clipboard text joins with `\n`.
 */
suite('block commands — copy/cut', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
    });

    async function openTsk(content: string, cursorLine: number): Promise<vscode.TextEditor> {
        const doc = await vscode.workspace.openTextDocument({ content, language: 'tsk' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(cursorLine, 0, cursorLine, 0);
        await new Promise((resolve) => setImmediate(resolve));
        return editor;
    }

    const PARENT_BLOCK = ['- [ ] keep1', '- [ ] parent', '    - [ ] child', '- [ ] keep2'].join(
        '\n',
    );
    const BLOCK_TEXT = '- [ ] parent\n    - [ ] child'; // lines 1..2 of PARENT_BLOCK

    test('copy: the whole block goes to the clipboard, doc unchanged, block selected', async () => {
        await vscode.env.clipboard.writeText('sentinel');
        const editor = await openTsk(PARENT_BLOCK, 1);
        await vscode.commands.executeCommand('tsk.copyTaskBlock');

        assert.strictEqual(await vscode.env.clipboard.readText(), BLOCK_TEXT);
        assert.strictEqual(editor.document.getText(), PARENT_BLOCK, 'copy must not change the doc');
        // The block is left selected — the visual "select the whole block and copy it".
        assert.strictEqual(editor.document.getText(editor.selection), BLOCK_TEXT);
    });

    test('cut: the block goes to the clipboard and is removed with no orphan blank line', async () => {
        const editor = await openTsk(PARENT_BLOCK, 1);
        await vscode.commands.executeCommand('tsk.cutTaskBlock');

        assert.strictEqual(await vscode.env.clipboard.readText(), BLOCK_TEXT);
        // Siblings stay adjacent — the block plus exactly one terminator is gone.
        assert.strictEqual(editor.document.getText(), '- [ ] keep1\n- [ ] keep2');
    });

    test('cut: a block at end-of-file consumes the PRECEDING newline (no orphan blank)', async () => {
        const eofBlock = ['- [ ] keep', '- [ ] block', '    - [ ] child'].join('\n');
        const editor = await openTsk(eofBlock, 1);
        await vscode.commands.executeCommand('tsk.cutTaskBlock');

        assert.strictEqual(await vscode.env.clipboard.readText(), '- [ ] block\n    - [ ] child');
        assert.strictEqual(editor.document.getText(), '- [ ] keep');
    });

    test('copy on a NON-task line defers to native line-copy (no block expansion)', async () => {
        // A non-task parent with an indented child: block logic WOULD grab the
        // child, but a non-task line falls through to native (the one line only).
        const editor = await openTsk('a parent paragraph\n    - [ ] child', 0);
        await vscode.env.clipboard.writeText('sentinel');
        await vscode.commands.executeCommand('tsk.copyTaskBlock');

        const clip = await vscode.env.clipboard.readText();
        assert.ok(clip.includes('a parent paragraph'), 'native copied the cursor line');
        assert.ok(!clip.includes('child'), 'must NOT have expanded to the block on a non-task line');
        assert.strictEqual(editor.document.getText(), 'a parent paragraph\n    - [ ] child');
    });

    test('copy WITH a selection defers to native (copies the selection, not the block)', async () => {
        const editor = await openTsk(PARENT_BLOCK, 0);
        editor.selection = new vscode.Selection(0, 6, 0, 11); // "keep1"
        await new Promise((resolve) => setImmediate(resolve));
        await vscode.commands.executeCommand('tsk.copyTaskBlock');

        assert.strictEqual(await vscode.env.clipboard.readText(), 'keep1');
    });

    test('contributes.keybindings binds Ctrl/Cmd+C/X to the block commands, gated no-selection', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const keybindings = ext.packageJSON.contributes.keybindings as ReadonlyArray<{
            command: string;
            key: string;
            mac?: string;
            when: string;
        }>;
        const when = "editorLangId == 'tsk' && editorTextFocus && !editorHasSelection";
        for (const exp of [
            { command: 'tsk.copyTaskBlock', key: 'ctrl+c', mac: 'cmd+c' },
            { command: 'tsk.cutTaskBlock', key: 'ctrl+x', mac: 'cmd+x' },
        ]) {
            const found = keybindings.find((k) => k.command === exp.command);
            assert.ok(found, `expected keybinding for ${exp.command}`);
            assert.strictEqual(found.key, exp.key);
            assert.strictEqual(found.mac, exp.mac);
            assert.strictEqual(found.when, when);
        }
    });
});
