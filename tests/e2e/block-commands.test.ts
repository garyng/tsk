import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { blockExpandTarget } from '../../src/block-commands';

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

        assert.strictEqual(await vscode.env.clipboard.readText(), `${BLOCK_TEXT}\n`); // trailing newline on by default
        assert.strictEqual(editor.document.getText(), PARENT_BLOCK, 'copy must not change the doc');
        // The block is left selected — the visual "select the whole block and copy it".
        assert.strictEqual(editor.document.getText(editor.selection), BLOCK_TEXT);
    });

    test('cut: the block goes to the clipboard and is removed with no orphan blank line', async () => {
        const editor = await openTsk(PARENT_BLOCK, 1);
        await vscode.commands.executeCommand('tsk.cutTaskBlock');

        assert.strictEqual(await vscode.env.clipboard.readText(), `${BLOCK_TEXT}\n`); // trailing newline on by default
        // Siblings stay adjacent — the block plus exactly one terminator is gone.
        assert.strictEqual(editor.document.getText(), '- [ ] keep1\n- [ ] keep2');
    });

    test('cut: a block at end-of-file consumes the PRECEDING newline (no orphan blank)', async () => {
        const eofBlock = ['- [ ] keep', '- [ ] block', '    - [ ] child'].join('\n');
        const editor = await openTsk(eofBlock, 1);
        await vscode.commands.executeCommand('tsk.cutTaskBlock');

        assert.strictEqual(await vscode.env.clipboard.readText(), '- [ ] block\n    - [ ] child\n');
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
        assert.ok(
            !clip.includes('child'),
            'must NOT have expanded to the block on a non-task line',
        );
        assert.strictEqual(editor.document.getText(), 'a parent paragraph\n    - [ ] child');
    });

    test('copy WITH a selection defers to native (copies the selection, not the block)', async () => {
        const editor = await openTsk(PARENT_BLOCK, 0);
        editor.selection = new vscode.Selection(0, 6, 0, 11); // "keep1"
        await new Promise((resolve) => setImmediate(resolve));
        await vscode.commands.executeCommand('tsk.copyTaskBlock');

        assert.strictEqual(await vscode.env.clipboard.readText(), 'keep1');
    });

    test('copy: trailing newline is omitted when tsk.copyBlockTrailingNewline is off', async () => {
        const config = vscode.workspace.getConfiguration('tsk');
        await config.update(
            'copyBlockTrailingNewline',
            false,
            vscode.ConfigurationTarget.Workspace,
        );
        try {
            await openTsk(PARENT_BLOCK, 1);
            await vscode.commands.executeCommand('tsk.copyTaskBlock');
            assert.strictEqual(await vscode.env.clipboard.readText(), BLOCK_TEXT); // no trailing \n
        } finally {
            await config.update(
                'copyBlockTrailingNewline',
                undefined,
                vscode.ConfigurationTarget.Workspace,
            );
        }
    });

    test('select: on a parent task, the whole block is selected', async () => {
        const editor = await openTsk(PARENT_BLOCK, 1);
        await vscode.commands.executeCommand('tsk.selectTaskBlock');
        assert.strictEqual(editor.document.getText(editor.selection), BLOCK_TEXT);
    });

    test('select: on a leaf task, just that line is selected', async () => {
        const editor = await openTsk(PARENT_BLOCK, 0); // "- [ ] keep1" — no children
        await vscode.commands.executeCommand('tsk.selectTaskBlock');
        assert.strictEqual(editor.document.getText(editor.selection), '- [ ] keep1');
    });

    test('select: on a non-task line it is a no-op (selection stays a bare cursor)', async () => {
        const editor = await openTsk('just a paragraph\n- [ ] task', 0);
        await vscode.commands.executeCommand('tsk.selectTaskBlock');
        assert.ok(editor.selection.isEmpty, 'selection should remain an empty cursor');
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

    test('contributes.configuration declares tsk.copyBlockTrailingNewline default true', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const setting =
            ext.packageJSON.contributes.configuration.properties['tsk.copyBlockTrailingNewline'];
        assert.ok(setting, 'tsk.copyBlockTrailingNewline should be declared');
        assert.strictEqual(setting.type, 'boolean');
        assert.strictEqual(setting.default, true);
    });
});

/**
 * Double-click → select block: the listener's decision, `blockExpandTarget`.
 * A real double-click's `kind === Mouse` can't be synthesized in the host, so we
 * test the decision function directly (the listener is a thin
 * read-setting → decide → `selectBlockAt` wrapper; `selectBlockAt` is covered by
 * the select tests above). `- [ ] parent` → content starts at col 6, so the
 * marker interior is cols 3..4 and the content "parent" is cols 6..12.
 */
suite('block commands — double-click decision (blockExpandTarget)', () => {
    suiteSetup(async () => {
        await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    });

    const Kind = vscode.TextEditorSelectionChangeKind;
    const TASK = '- [ ] parent <!-- @id:p1 -->';
    const tskDoc = (content: string): Thenable<vscode.TextDocument> =>
        vscode.workspace.openTextDocument({ content, language: 'tsk' });
    const sel = (line: number, c1: number, c2: number): vscode.Selection =>
        new vscode.Selection(line, c1, line, c2);

    test('a Mouse selection in the marker prefix returns the task line', async () => {
        const doc = await tskDoc(TASK);
        assert.strictEqual(blockExpandTarget(doc, [sel(0, 3, 4)], Kind.Mouse, true), 0);
    });

    test('a Mouse selection in the content returns null (word-select preserved)', async () => {
        const doc = await tskDoc(TASK);
        assert.strictEqual(blockExpandTarget(doc, [sel(0, 6, 12)], Kind.Mouse, true), null);
    });

    test('a non-Mouse selection (keyboard / command / undefined) returns null', async () => {
        const doc = await tskDoc(TASK);
        const prefix = [sel(0, 3, 4)];
        assert.strictEqual(blockExpandTarget(doc, prefix, Kind.Keyboard, true), null);
        assert.strictEqual(blockExpandTarget(doc, prefix, Kind.Command, true), null);
        assert.strictEqual(blockExpandTarget(doc, prefix, undefined, true), null);
    });

    test('disabled (setting off) returns null even for a prefix Mouse selection', async () => {
        const doc = await tskDoc(TASK);
        assert.strictEqual(blockExpandTarget(doc, [sel(0, 3, 4)], Kind.Mouse, false), null);
    });

    test('a non-task line returns null', async () => {
        const doc = await tskDoc('just a paragraph');
        assert.strictEqual(blockExpandTarget(doc, [sel(0, 0, 4)], Kind.Mouse, true), null);
    });

    test('multiple, empty, or multi-line selections return null', async () => {
        const doc = await tskDoc(`${TASK}\n    - [ ] child`);
        assert.strictEqual(
            blockExpandTarget(doc, [sel(0, 3, 4), sel(0, 0, 1)], Kind.Mouse, true),
            null,
        );
        assert.strictEqual(blockExpandTarget(doc, [sel(0, 3, 3)], Kind.Mouse, true), null); // empty
        const multiLine = new vscode.Selection(0, 3, 1, 4);
        assert.strictEqual(blockExpandTarget(doc, [multiLine], Kind.Mouse, true), null);
    });

    test('contributes.configuration declares tsk.doubleClickSelectsBlock default true', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const setting =
            ext.packageJSON.contributes.configuration.properties['tsk.doubleClickSelectsBlock'];
        assert.ok(setting, 'tsk.doubleClickSelectsBlock should be declared');
        assert.strictEqual(setting.type, 'boolean');
        assert.strictEqual(setting.default, true);
    });
});
