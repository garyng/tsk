import * as assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { Logger } from '../../src/lib/logger';
import { buildPastedImageEdit } from '../../src/paste-image';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Paste-image e2e (M23). The provider's `provideDocumentPasteEdits` can't be
 * replayed end-to-end: a hand-built `DataTransferItem` returns `undefined`
 * from `asFile()` (only VSCode-internal items from a real OS paste yield a
 * file), and the no-selection / conflict flows show input boxes that
 * `executeCommand` can't drive. So we exercise the documented seam —
 * `buildPastedImageEdit(docDir, relPath, bytes, logger)` — directly, then
 * apply its `additionalEdit` (the `WorkspaceEdit.createFile`) to materialise
 * the file. Pure path/snippet logic is covered by vitest in
 * `src/lib/paste-image-logic.test.ts`.
 *
 * Each test writes into a throwaway dir under the workspace (so `applyEdit`'s
 * `createFile` stays in-workspace) and removes it in teardown.
 */
suite('paste-image (M23)', () => {
    // Distinct byte payloads so the overwrite test can prove the bytes changed.
    const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb]);
    const logger = new Logger({ appendLine: () => {} });

    let workspaceFolder: string;
    const tmpDirs: string[] = [];

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'expected a workspace folder');
        workspaceFolder = folder.uri.fsPath;
    });

    teardown(() => {
        for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    /** A unique, hidden, auto-cleaned directory under the workspace. */
    function makeDocDir(): string {
        const dir = mkdtempSync(join(workspaceFolder, '.paste-e2e-'));
        tmpDirs.push(dir);
        return dir;
    }

    function snippetValue(edit: vscode.DocumentPasteEdit): string {
        assert.ok(
            edit.insertText instanceof vscode.SnippetString,
            'insertText should be a snippet',
        );
        return (edit.insertText as vscode.SnippetString).value;
    }

    test('builds the snippet but does not write until the additionalEdit applies', async () => {
        const docDir = makeDocDir();
        const edit = buildPastedImageEdit(docDir, 'images/shot.png', PNG_A, logger);

        // Alt text is a ${1} placeholder; path is forward-slashed + ./-prefixed.
        assert.strictEqual(snippetValue(edit), '![${1:shot}](./images/shot.png)');
        assert.ok(edit.kind, 'edit should carry a kind');
        assert.match(edit.kind.value, /markdown/);
        assert.ok(edit.additionalEdit, 'expected an additionalEdit carrying the file creation');

        const target = join(docDir, 'images', 'shot.png');
        assert.ok(!existsSync(target), 'file must not exist before applyEdit');

        const applied = await vscode.workspace.applyEdit(
            edit.additionalEdit as vscode.WorkspaceEdit,
        );
        assert.ok(applied, 'applyEdit should succeed');
        assert.ok(existsSync(target), 'file should exist after applyEdit');
        assert.deepStrictEqual(new Uint8Array(readFileSync(target)), PNG_A);
    });

    test('creates intermediate directories for a nested selection path', async () => {
        const docDir = makeDocDir();
        const edit = buildPastedImageEdit(docDir, 'a/b/c/diagram.png', PNG_A, logger);

        assert.strictEqual(snippetValue(edit), '![${1:diagram}](./a/b/c/diagram.png)');
        await vscode.workspace.applyEdit(edit.additionalEdit as vscode.WorkspaceEdit);
        assert.ok(
            existsSync(join(docDir, 'a', 'b', 'c', 'diagram.png')),
            'nested dirs + file created',
        );
    });

    test('overwrite replaces the existing bytes (overwrite-anyway path)', async () => {
        const docDir = makeDocDir();
        const target = join(docDir, 'images', 'shot.png');
        mkdirSync(join(docDir, 'images'), { recursive: true });
        writeFileSync(target, PNG_A); // pre-existing original

        const edit = buildPastedImageEdit(docDir, 'images/shot.png', PNG_B, logger);
        const applied = await vscode.workspace.applyEdit(
            edit.additionalEdit as vscode.WorkspaceEdit,
        );
        assert.ok(applied, 'applyEdit should succeed over an existing file');
        assert.deepStrictEqual(
            new Uint8Array(readFileSync(target)),
            PNG_B,
            'bytes should be replaced by the overwrite',
        );
    });

    test('angle-wraps a destination containing a space', () => {
        const docDir = makeDocDir();
        const edit = buildPastedImageEdit(docDir, 'my shot.png', PNG_A, logger);
        assert.strictEqual(snippetValue(edit), '![${1:my shot}](<./my shot.png>)');
    });

    test('absolute target is used verbatim and yields a ../ relative link', async () => {
        const docDir = makeDocDir();
        const otherDir = makeDocDir(); // sibling temp dir, outside docDir
        const abs = join(otherDir, 'out.png');

        const edit = buildPastedImageEdit(docDir, abs, PNG_A, logger);
        // docDir and otherDir are siblings, so the document-relative path climbs.
        assert.match(snippetValue(edit), /^!\[\$\{1:out\}\]\(\.\.\//);

        await vscode.workspace.applyEdit(edit.additionalEdit as vscode.WorkspaceEdit);
        assert.ok(existsSync(abs), 'absolute target should be written as-is');
    });
});
