import * as assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';

/**
 * `tsk:<id>` in a Markdown file: the links, and the live marker drawn after
 * each. The plan lives in a temp directory (a `.md` there is never scanned);
 * the tasks it names are `sample.tsk`'s, whose ids are hand-written, so they
 * count as known rather than by their shape.
 */
suite('tsk:<id> references', () => {
    let api: TskExtensionApi;
    let dir: string;
    let plan: vscode.TextDocument;
    let sampleUri: vscode.Uri;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();
        const firstFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(firstFolder, 'expected a workspace folder');
        sampleUri = vscode.Uri.joinPath(firstFolder.uri, 'sample.tsk');

        dir = mkdtempSync(join(tmpdir(), 'tsk-refs-e2e-'));
        writeFileSync(
            join(dir, 'plan.md'),
            [
                '# A plan',
                '- tsk:m3task3 is done',
                '- tsk:m3task1 waits; tsk:zzzzzzzz is no task; run task tsk:test',
                '',
            ].join('\n'),
        );
        plan = await vscode.workspace.openTextDocument(join(dir, 'plan.md'));
    });

    setup(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.window.showTextDocument(plan);
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        rmSync(dir, { recursive: true, force: true });
    });

    /** Poll for a condition, for at most two seconds. */
    const waitFor = async (probe: () => boolean): Promise<boolean> => {
        for (let attempt = 0; attempt < 40; attempt++) {
            if (probe()) return true;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
    };

    const markerAt = (id: string) =>
        api.getTaskRefDecorations(plan.uri.toString())?.find((d) => d.id === id)?.marker;

    test('known ids and unknown generated-looking ids are links; tsk:test is not', async () => {
        const all = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
            'vscode.executeLinkProvider',
            plan.uri,
        );
        const refs = (all ?? [])
            .map((l) => ({ text: plan.getText(l.range), target: l.target?.toString(true) }))
            .filter((l) => l.text.startsWith('tsk:'));
        assert.deepStrictEqual(
            refs.map((l) => l.text),
            ['tsk:m3task3', 'tsk:m3task1', 'tsk:zzzzzzzz'],
        );
        assert.strictEqual(refs[0]?.target, 'command:tsk.revealTask?["m3task3"]');
    });

    test('each shown ref has its task’s marker after it, or none for an unknown id', async () => {
        assert.ok(
            await waitFor(() => api.getTaskRefDecorations(plan.uri.toString()) !== undefined),
        );
        assert.deepStrictEqual(api.getTaskRefDecorations(plan.uri.toString()), [
            { line: 1, character: 13, id: 'm3task3', marker: 'completed' },
            { line: 2, character: 13, id: 'm3task1', marker: 'todo' },
            { line: 2, character: 33, id: 'zzzzzzzz', marker: undefined },
        ]);
    });

    test('the marker follows the task when its .tsk file changes', async () => {
        const sample = await vscode.workspace.openTextDocument(sampleUri);
        const beside = await vscode.window.showTextDocument(sample, vscode.ViewColumn.Beside, true);
        const line = api.findTaskById('m3task1')?.line;
        assert.ok(line !== undefined);
        const at = sample.lineAt(line).text.indexOf('[ ]');
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(sampleUri, new vscode.Range(line, at + 1, line, at + 2), 'x');
            assert.ok(await vscode.workspace.applyEdit(edit));
            assert.ok(
                await waitFor(() => markerAt('m3task1') === 'completed'),
                `m3task1's marker should follow the edit, was ${markerAt('m3task1')}`,
            );
        } finally {
            // Reverted beside the plan: markers are drawn in visible editors only.
            await vscode.window.showTextDocument(sample, beside.viewColumn);
            await vscode.commands.executeCommand('workbench.action.files.revert');
        }
        assert.ok(await waitFor(() => markerAt('m3task1') === 'todo'));
    });

    test('following a link reveals the task', async () => {
        const editor = await vscode.window.showTextDocument(plan);
        editor.selection = new vscode.Selection(1, 6, 1, 6);
        await vscode.commands.executeCommand('editor.action.openLink');
        // The new editor and its selection reach the extension host separately.
        const line = api.findTaskById('m3task3')?.line;
        const landed = () => {
            const active = vscode.window.activeTextEditor;
            return (
                active?.document.uri.toString() === sampleUri.toString() &&
                active.selection.active.line === line
            );
        };
        assert.ok(
            await waitFor(landed),
            `following tsk:m3task3 should open sample.tsk at line ${line}, got ${vscode.window.activeTextEditor?.document.uri.toString()}:${vscode.window.activeTextEditor?.selection.active.line}`,
        );
    });
});
