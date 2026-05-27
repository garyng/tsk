import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';

/**
 * List-edit (Enter / Tab / Shift+Tab) e2e. Uses untitled `.tsk` docs so
 * the cache isn't polluted (per the M5/B `isUntitled` rescan fix).
 *
 * Cursor positions + asserted outputs are pinned to the deterministic
 * intercept paths in the pure helpers (M7/A). The default-fallback
 * branches (where the helper returns `noop` and we defer to VSCode's
 * default `type` / `tab` / outdent) are only spot-checked for "didn't
 * throw, document changed in the expected direction" since their exact
 * behavior depends on editor settings + the broader extension stack.
 */
suite('list-edit (Enter / Tab / Shift+Tab)', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
    });

    async function runKey(
        content: string,
        commandId: string,
        line: number,
        col: number,
    ): Promise<{ text: string; cursorLine: number; cursorCol: number }> {
        const doc = await vscode.workspace.openTextDocument({ content, language: 'tsk' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(line, col, line, col);
        await new Promise((resolve) => setImmediate(resolve));
        await vscode.commands.executeCommand(commandId);
        return {
            text: doc.getText(),
            cursorLine: editor.selection.active.line,
            cursorCol: editor.selection.active.character,
        };
    }

    test('Enter at end-before-metadata creates an empty continuation with metadata pinned', async () => {
        // `- [ ] foo <!-- @id:x -->`, cursor at col 9 (the space before `<--`).
        // contentEnd = 9, so cursor ≥ contentEnd → empty continuation; line 1
        // stays byte-for-byte, line 2 is a fresh empty task with the
        // two-space cursor-spacer between marker and metadata.
        const result = await runKey('- [ ] foo <!-- @id:x -->', 'tsk.handleEnter', 0, 9);
        const lines = result.text.split('\n');
        assert.strictEqual(lines[0], '- [ ] foo <!-- @id:x -->');
        assert.match(lines[1] ?? '', /^- \[ \] {2}<!-- @id:[a-z0-9]+ @created:[\d\-T:+]+ -->$/);
        assert.strictEqual(result.cursorLine, 1);
        assert.strictEqual(result.cursorCol, 6);
    });

    test('Enter mid-content with metadata pins the metadata to the first line', async () => {
        const result = await runKey('- [ ] foo bar <!-- @id:x -->', 'tsk.handleEnter', 0, 10);
        const lines = result.text.split('\n');
        assert.strictEqual(lines[0], '- [ ] foo <!-- @id:x -->');
        assert.match(lines[1] ?? '', /^- \[ \] bar <!-- @id:[a-z0-9]+ @created:[\d\-T:+]+ -->$/);
        assert.strictEqual(result.cursorLine, 1);
        assert.strictEqual(result.cursorCol, 6);
    });

    test('Enter on empty task at column 0 removes the whole task', async () => {
        const result = await runKey('- [ ] ', 'tsk.handleEnter', 0, 6);
        assert.strictEqual(result.text, '');
        assert.strictEqual(result.cursorLine, 0);
        assert.strictEqual(result.cursorCol, 0);
    });

    test('Enter on an empty task with metadata at column 0 drops the metadata too', async () => {
        const result = await runKey('- [ ] <!-- @id:x -->', 'tsk.handleEnter', 0, 6);
        assert.strictEqual(result.text, '');
    });

    test('Enter on indented empty task outdents one level', async () => {
        const result = await runKey('    - [ ] ', 'tsk.handleEnter', 0, 10);
        assert.strictEqual(result.text, '- [ ] ');
        assert.strictEqual(result.cursorLine, 0);
        assert.strictEqual(result.cursorCol, 6);
    });

    test('Tab on empty task indents one level (4 spaces by default)', async () => {
        const result = await runKey('- [ ] ', 'tsk.handleTab', 0, 6);
        assert.strictEqual(result.text, '    - [ ] ');
        assert.strictEqual(result.cursorCol, 10);
    });

    test('Shift+Tab on indented task dedents one level', async () => {
        const result = await runKey('    - [ ] foo', 'tsk.handleShiftTab', 0, 10);
        assert.strictEqual(result.text, '- [ ] foo');
        assert.strictEqual(result.cursorCol, 6);
    });

    test('Enter on non-task line falls through to default (inserts newline)', async () => {
        const result = await runKey('plain text', 'tsk.handleEnter', 0, 5);
        const lines = result.text.split('\n');
        // The default `type` command inserts a `\n` at the cursor — the
        // exact post-newline indentation depends on editor settings, but
        // we should have at least 2 lines now and the cursor on line 1.
        assert.ok(lines.length >= 2, `expected at least 2 lines, got ${lines.length}`);
        assert.strictEqual(result.cursorLine, 1);
    });

    test('contributes.keybindings registers Enter / Tab / Shift+Tab gated to tsk', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const keybindings = ext.packageJSON.contributes.keybindings as ReadonlyArray<{
            command: string;
            key: string;
            when: string;
        }>;
        const expected: ReadonlyArray<[string, string]> = [
            ['tsk.handleEnter', 'enter'],
            ['tsk.handleTab', 'tab'],
            ['tsk.handleShiftTab', 'shift+tab'],
        ];
        for (const [command, key] of expected) {
            const found = keybindings.find((k) => k.command === command);
            assert.ok(found, `expected keybinding for ${command}`);
            assert.strictEqual(found.key, key);
            assert.match(found.when, /editorLangId == 'tsk'/);
            assert.match(found.when, /!suggestWidgetVisible/);
            assert.match(found.when, /!inSnippetMode/);
        }
    });
});
