import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Duplicate-line e2e (Shift+Alt+Down / Shift+Alt+Up). Each test uses an
 * untitled `.tsk` doc. The commands wrap VS Code's built-in `copyLines*` and
 * then rewrite the `@id` + `@created` of every copied task line, so a
 * duplicated task never collides with its source on the cache primary key.
 *
 * Source `@id`s are literal sentinels (`srcid000`, …) — they don't have to be
 * valid nanoids; the copies are matched by character class since the rewrite
 * uses the real `generateId`.
 */
suite('duplicate-line commands', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
    });

    async function runDuplicate(
        content: string,
        commandId: string,
        cursorLines: readonly number[],
    ): Promise<string[]> {
        const doc = await vscode.workspace.openTextDocument({ content, language: 'tsk' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selections = cursorLines.map((l) => new vscode.Selection(l, 0, l, 0));
        await new Promise((resolve) => setImmediate(resolve));
        await vscode.commands.executeCommand(commandId);
        return doc.getText().split('\n');
    }

    /** Position-agnostic: exactly one line is the untouched source, the other a rewritten copy. */
    function assertOneSourceOneCopy(lines: string[], src: string, srcId: string): void {
        assert.strictEqual(lines.length, 2);
        const copies = lines.filter((l) => l !== src);
        assert.strictEqual(copies.length, 1, 'exactly one line should be a rewritten copy');
        assert.match(copies[0] ?? '', /^- \[ \] task <!-- @id:[a-z0-9]+ @created:[\d\-T:+]+ -->$/);
        const copyId = /@id:([a-z0-9]+)/.exec(copies[0] ?? '')?.[1];
        assert.ok(copyId && copyId !== srcId, `copy @id should differ from source, got ${copyId}`);
    }

    const SRC = '- [ ] task <!-- @id:srcid000 @created:2026-01-01T00:00:00+08:00 -->';

    test('duplicateLineDown gives the copy a fresh @id + @created, source intact', async () => {
        const lines = await runDuplicate(SRC, 'tsk.duplicateLineDown', [0]);
        assertOneSourceOneCopy(lines, SRC, 'srcid000');
    });

    test('duplicateLineUp gives the copy a fresh @id + @created, source intact', async () => {
        const lines = await runDuplicate(SRC, 'tsk.duplicateLineUp', [0]);
        assertOneSourceOneCopy(lines, SRC, 'srcid000');
    });

    test('preserves lifecycle stamps on the copy (only @id + @created change)', async () => {
        const src =
            '- [/] task <!-- @id:srcid000 @created:2026-01-01T00:00:00+08:00 @started:2026-02-02T09:00:00+08:00 -->';
        const lines = await runDuplicate(src, 'tsk.duplicateLineDown', [0]);
        const copy = lines.find((l) => l !== src) ?? '';
        assert.match(copy, /@started:2026-02-02T09:00:00\+08:00/);
        const copyId = /@id:([a-z0-9]+)/.exec(copy)?.[1];
        assert.ok(copyId && copyId !== 'srcid000');
    });

    test('multi-cursor duplicateLineDown rewrites every copy with a distinct @id', async () => {
        const content = [
            '- [ ] a <!-- @id:srcaaa00 @created:2026-01-01T00:00:00+08:00 -->',
            '- [ ] b <!-- @id:srcbbb00 @created:2026-01-01T00:00:00+08:00 -->',
        ].join('\n');
        const lines = await runDuplicate(content, 'tsk.duplicateLineDown', [0, 1]);
        const ids = lines
            .map((l) => /@id:([a-z0-9]+)/.exec(l)?.[1])
            .filter((id): id is string => Boolean(id));
        assert.strictEqual(ids.length, 4, 'two sources + two copies');
        assert.strictEqual(new Set(ids).size, 4, 'all four @ids should be distinct');
        assert.ok(ids.includes('srcaaa00') && ids.includes('srcbbb00'), 'both sources preserved');
    });

    test('duplicating a non-task line copies it verbatim', async () => {
        const lines = await runDuplicate('just a paragraph', 'tsk.duplicateLineDown', [0]);
        assert.deepStrictEqual(lines, ['just a paragraph', 'just a paragraph']);
    });

    test('contributes.keybindings registers Shift+Alt+Down/Up gated to tsk', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const keybindings = ext.packageJSON.contributes.keybindings as ReadonlyArray<{
            command: string;
            key: string;
            when: string;
        }>;
        const expected = [
            { command: 'tsk.duplicateLineDown', key: 'shift+alt+down' },
            { command: 'tsk.duplicateLineUp', key: 'shift+alt+up' },
        ];
        for (const exp of expected) {
            const found = keybindings.find((k) => k.command === exp.command);
            assert.ok(found, `expected keybinding for ${exp.command}`);
            assert.strictEqual(found.key, exp.key);
            assert.strictEqual(found.when, "editorLangId == 'tsk' && editorTextFocus");
        }
    });
});
