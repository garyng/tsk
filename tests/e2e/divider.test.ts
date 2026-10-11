import * as assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';
const DIVIDER = `-todo${'-'.repeat(20)}`;

/**
 * Divider folding e2e. The load-bearing test is "indentation folding SURVIVES
 * the provider": registering a
 * `FoldingRangeProvider` replaces VS Code's built-in indentation strategy, so
 * the provider has to re-emit indentation ranges or task-block folding
 * silently disappears. That was measured, not assumed — and it is the kind of
 * regression nothing else would catch.
 */
suite('divider folding', () => {
    let dir: string;
    let doc: vscode.TextDocument;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();

        dir = mkdtempSync(join(tmpdir(), 'tsk-divider-e2e-'));
        writeFileSync(
            join(dir, 'sections.tsk'),
            [
                '- [ ] parent <!-- @id:dv-p -->', // 0
                '    - [ ] child <!-- @id:dv-c1 @parent:dv-p -->', // 1
                '    - [ ] child2 <!-- @id:dv-c2 @parent:dv-p -->', // 2
                DIVIDER, // 3
                '- [ ] after <!-- @id:dv-a1 -->', // 4
                '- [ ] after2 <!-- @id:dv-a2 -->', // 5
                '', // 6
            ].join('\n'),
        );
        doc = await vscode.workspace.openTextDocument(join(dir, 'sections.tsk'));
        await vscode.window.showTextDocument(doc);
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        rmSync(dir, { recursive: true, force: true });
    });

    const ranges = async (): Promise<vscode.FoldingRange[]> =>
        (await vscode.commands.executeCommand<vscode.FoldingRange[]>(
            'vscode.executeFoldingRangeProvider',
            doc.uri,
        )) ?? [];

    test('a divider folds to the last content line of its section', async () => {
        const region = (await ranges()).find((r) => r.kind === vscode.FoldingRangeKind.Region);
        assert.ok(region, 'the divider should contribute a Region fold');
        assert.strictEqual(region.start, 3, 'starts on the divider line');
        // 5, not 6: the trailing blank line is not part of the section.
        assert.strictEqual(region.end, 5, 'ends on the last content line, not the blank');
    });

    test('the divider line raises no diagnostics', async () => {
        // The parser-level guarantee (a divider is never a task or a bullet) is
        // pinned by `lib/divider.test.ts`; this checks the editor-facing side.
        assert.strictEqual(
            vscode.languages.getDiagnostics(doc.uri).filter((d) => d.range.start.line === 3).length,
            0,
            'the divider line raises no diagnostics',
        );
    });

    test('indentation folding SURVIVES the provider (the whole point)', async () => {
        const all = await ranges();
        const block = all.find((r) => r.start === 0);
        assert.ok(block, `the task block at line 0 must still fold; got ${JSON.stringify(all)}`);
        assert.strictEqual(block.end, 2, 'parent folds over both children');
        assert.notStrictEqual(
            block.kind,
            vscode.FoldingRangeKind.Region,
            'an indentation fold is kind-less, like VS Code’s own',
        );
    });

    test('the insert command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('tsk.insertDivider'));
    });
});
