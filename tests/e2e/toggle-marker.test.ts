import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Marker-toggle e2e suite. Each test opens its own untitled `.tsk` doc so
 * runs don't leak state into the workspace fixture (which the cache /
 * decoration suites already pin assertions against). Untitled docs share
 * the extension's activation but don't show up in `counts.files`.
 *
 * Timestamps are matched by regex since the activation uses the real
 * `localTimestamp` factory; @id values are matched by character class
 * since `generateId` is the real `nanoid`.
 */
suite('toggle marker commands', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
    });

    async function runToggle(
        content: string,
        commandId: string,
        cursorLines: readonly number[],
    ): Promise<string[]> {
        const doc = await vscode.workspace.openTextDocument({ content, language: 'tsk' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selections = cursorLines.map((l) => new vscode.Selection(l, 0, l, 0));
        // Yield so onDidChangeActiveTextEditor handlers run before we dispatch.
        await new Promise((resolve) => setImmediate(resolve));
        await vscode.commands.executeCommand(commandId);
        return doc.getText().split('\n');
    }

    test('toggleTodo wraps a plain line into a todo with @id + @created', async () => {
        const [first] = await runToggle('write the spec', 'tsk.toggleTodo', [0]);
        assert.match(
            first ?? '',
            /^- \[ \] write the spec <!-- @id:[a-z0-9]+ @created:[\d\-T:+]+ -->$/,
        );
    });

    test('toggleTodo wraps a bare bullet without doubling the marker', async () => {
        // `- milk` (a checkbox-less list item) becomes `- [ ] milk`, never
        // `- [ ] - milk`. The existing bullet is stripped, not re-bulleted.
        const [first] = await runToggle('- milk', 'tsk.toggleTodo', [0]);
        assert.match(first ?? '', /^- \[ \] milk <!-- @id:[a-z0-9]+ @created:[\d\-T:+]+ -->$/);
    });

    test('toggleTodo unwraps an empty todo', async () => {
        const [first] = await runToggle('- [ ] <!-- @id:abc -->', 'tsk.toggleTodo', [0]);
        assert.strictEqual(first, '');
    });

    test('toggleTodo no-ops on a todo that already has @id', async () => {
        const before = '- [ ] still doing this <!-- @id:abc -->';
        const [first] = await runToggle(before, 'tsk.toggleTodo', [0]);
        assert.strictEqual(first, before);
    });

    test('toggleTodo promotes a markered-but-no-id todo by adding @id + @created', async () => {
        // User hand-typed `- [ ] needs id` or imported it from elsewhere.
        // Alt+A fills in the missing metadata so the line becomes a
        // first-class workspace task (graph-visible, lens-able, etc).
        const [first] = await runToggle('- [ ] needs id', 'tsk.toggleTodo', [0]);
        assert.match(first ?? '', /^- \[ \] needs id <!-- @id:[a-z0-9]+ @created:[\d\-T:+]+ -->$/);
    });

    test('toggleNote promotes a markered-but-no-id note by adding @id + @created', async () => {
        const [first] = await runToggle('- [n] aside', 'tsk.toggleNote', [0]);
        assert.match(first ?? '', /^- \[n\] aside <!-- @id:[a-z0-9]+ @created:[\d\-T:+]+ -->$/);
    });

    test('toggleTodo on a blank line lands the cursor between the two spacer columns', async () => {
        // Alt+A on a blank line emits `- [ ]  <!-- @id:… -->` with two
        // spaces between marker and metadata. The cursor should sit between
        // them (column 6) so a follow-up keystroke produces a well-spaced
        // `- [ ] foo <!-- … -->`.
        const doc = await vscode.workspace.openTextDocument({ content: '', language: 'tsk' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selections = [new vscode.Selection(0, 0, 0, 0)];
        await new Promise((resolve) => setImmediate(resolve));
        await vscode.commands.executeCommand('tsk.toggleTodo');
        const text = doc.lineAt(0).text;
        assert.match(text, /^- \[ \] {2}<!-- @id:[a-z0-9]+ @created:[\d\-T:+]+ -->$/);
        const cursor = editor.selection.active;
        assert.strictEqual(cursor.line, 0);
        assert.strictEqual(cursor.character, 6);
    });

    test('toggleInprogress flips todo to in-progress with @started', async () => {
        const [first] = await runToggle('- [ ] thing', 'tsk.toggleInprogress', [0]);
        assert.match(first ?? '', /^- \[\/\] thing <!-- @started:[\d\-T:+]+ -->$/);
    });

    test('toggleInprogress flips back to todo and removes @started', async () => {
        const [first] = await runToggle(
            '- [/] thing <!-- @started:2026-05-25T09:00:00+08:00 -->',
            'tsk.toggleInprogress',
            [0],
        );
        assert.strictEqual(first, '- [ ] thing');
    });

    test('toggleCompleted flips todo to completed with @completed', async () => {
        const [first] = await runToggle('- [ ] thing', 'tsk.toggleCompleted', [0]);
        assert.match(first ?? '', /^- \[x\] thing <!-- @completed:[\d\-T:+]+ -->$/);
    });

    test('toggleCancelled flips todo to cancelled with @cancelled', async () => {
        const [first] = await runToggle('- [ ] thing', 'tsk.toggleCancelled', [0]);
        assert.match(first ?? '', /^- \[!\] thing <!-- @cancelled:[\d\-T:+]+ -->$/);
    });

    test('toggleNote wraps a plain line as a notes task', async () => {
        const [first] = await runToggle('aside', 'tsk.toggleNote', [0]);
        assert.match(first ?? '', /^- \[n\] aside <!-- @id:[a-z0-9]+ @created:[\d\-T:+]+ -->$/);
    });

    test('state toggles no-op on a non-task line', async () => {
        const [first] = await runToggle('not a task', 'tsk.toggleInprogress', [0]);
        assert.strictEqual(first, 'not a task');
    });

    test('multi-cursor on the same line deduplicates (toggle applied once)', async () => {
        // Two cursors on row 0. If we double-applied, toggleCompleted twice
        // would cancel itself back to a plain todo. Dedup keeps it applied.
        const [first] = await runToggle('- [ ] thing', 'tsk.toggleCompleted', [0, 0]);
        assert.match(first ?? '', /^- \[x\] thing <!-- @completed:[\d\-T:+]+ -->$/);
    });

    test('multi-cursor on different lines toggles each independently', async () => {
        const lines = await runToggle(
            '- [ ] one\n- [ ] two\n- [ ] three',
            'tsk.toggleCompleted',
            [0, 2],
        );
        assert.match(lines[0] ?? '', /^- \[x\] one <!-- @completed:[\d\-T:+]+ -->$/);
        assert.strictEqual(lines[1], '- [ ] two');
        assert.match(lines[2] ?? '', /^- \[x\] three <!-- @completed:[\d\-T:+]+ -->$/);
    });

    test('contributes.keybindings registers all 5 toggle keybindings gated to tsk', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const keybindings = ext.packageJSON.contributes.keybindings as ReadonlyArray<{
            command: string;
            key: string;
            when: string;
        }>;
        const expected = [
            { command: 'tsk.toggleTodo', key: 'alt+a' },
            { command: 'tsk.toggleInprogress', key: 'alt+s' },
            { command: 'tsk.toggleCompleted', key: 'alt+c' },
            { command: 'tsk.toggleCancelled', key: 'alt+x' },
            { command: 'tsk.toggleNote', key: 'alt+n' },
        ];
        for (const exp of expected) {
            const found = keybindings.find((k) => k.command === exp.command);
            assert.ok(found, `expected keybinding for ${exp.command}`);
            assert.strictEqual(found.key, exp.key);
            assert.strictEqual(found.when, "editorLangId == 'tsk'");
        }
    });
});
