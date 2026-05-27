import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';
const TAGS_PATH_KEY = 'tags.path';

/**
 * Tag-completion e2e. The fixture's `.vscode/tsk/tags.yml` defines
 * `project/tsk`, `milestone/M3`, `only-here`, and `yaml-only-not-in-tsk`.
 * `sample.tsk` actively uses `project/tsk`, `milestone/M3`, and `only-here`;
 * `yaml-only-not-in-tsk` is the "declared-but-not-discovered" exerciser.
 */
suite('tags completion', () => {
    let api: TskExtensionApi;
    let sampleUri: vscode.Uri;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();

        const firstFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(firstFolder, 'expected a workspace folder');
        sampleUri = vscode.Uri.joinPath(firstFolder.uri, 'sample.tsk');

        // Force a tags reload so the fixture yaml is loaded before any
        // assertion runs (the loader does an initial reload during
        // activation, but a redundant reload is cheap and makes the suite
        // robust against test reorderings).
        await api.reloadTags();
    });

    async function completionAt(
        uri: vscode.Uri,
        position: vscode.Position,
    ): Promise<vscode.CompletionList> {
        const result = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            uri,
            position,
            '#',
        );
        assert.ok(result, 'completion provider returned a list');
        return result;
    }

    test('completion items include both yaml-defined and discovered tags', async () => {
        // sample.tsk line 6 (0-indexed: 5) is `- [/] wire up the activation
        // #project/tsk <!-- ... -->`. Open the doc and trigger completion
        // at a position just after the `#` of `#project/tsk` (col 33).
        const doc = await vscode.workspace.openTextDocument(sampleUri);
        await vscode.window.showTextDocument(doc);

        // For a robust query, append a fresh `#` token at the end of an
        // empty trailing line, then trigger completion there. This avoids
        // depending on exact column math of pre-existing content.
        const lastLine = doc.lineCount - 1;
        const insertPos = new vscode.Position(lastLine, doc.lineAt(lastLine).text.length);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(sampleUri, insertPos, '\n- [ ] new task #');
        await vscode.workspace.applyEdit(edit);
        const newLine = lastLine + 1;
        const newText = doc.lineAt(newLine).text;
        const triggerPos = new vscode.Position(newLine, newText.length);

        const list = await completionAt(sampleUri, triggerPos);
        const labels = list.items.map((i) =>
            typeof i.label === 'string' ? i.label : i.label.label,
        );

        // Yaml-defined tags should all appear.
        assert.ok(labels.includes('project/tsk'), 'yaml tag project/tsk');
        assert.ok(labels.includes('milestone/M3'), 'yaml tag milestone/M3');
        assert.ok(labels.includes('only-here'), 'yaml tag only-here');
        assert.ok(
            labels.includes('yaml-only-not-in-tsk'),
            'yaml-only tag should surface even when no .tsk file uses it',
        );

        // Implicit parents from discovered tags should appear too.
        assert.ok(labels.includes('project'), 'implicit parent `project` from `project/tsk`');
        assert.ok(labels.includes('milestone'), 'implicit parent `milestone` from `milestone/M3`');

        // Yaml-defined tags carry their description as `detail`.
        const projectTsk = list.items.find(
            (i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'project/tsk',
        );
        assert.ok(projectTsk, 'project/tsk item found');
        assert.strictEqual(projectTsk.detail, 'The tsk extension itself');
        assert.strictEqual(projectTsk.kind, vscode.CompletionItemKind.Value);

        // Roll back the edit so the next test starts clean.
        const undo = new vscode.WorkspaceEdit();
        undo.delete(
            sampleUri,
            new vscode.Range(
                new vscode.Position(lastLine, doc.lineAt(lastLine).text.length),
                new vscode.Position(newLine, newText.length),
            ),
        );
        await vscode.workspace.applyEdit(undo);
    });

    test('changing tsk.tags.path picks up the new state', async function () {
        // Devcontainer + headless-vscode config-update propagation through
        // file-watcher + onDidChangeConfiguration is slow enough to brush
        // the 20s default. The test itself isn't asserting timing — it just
        // needs head-room.
        this.timeout(60000);
        const config = () => vscode.workspace.getConfiguration('tsk');
        const original = config().inspect<string>(TAGS_PATH_KEY)?.workspaceValue;
        try {
            // Point at a non-existent file → yaml state should empty out.
            await config().update(
                TAGS_PATH_KEY,
                '/tmp/tsk-e2e-nonexistent-tags.yml',
                vscode.ConfigurationTarget.Workspace,
            );
            // Setting-change handler fires `void reload()`; we drive the
            // promise to completion via the exposed reloadTags helper.
            await api.reloadTags();

            const tagsAfter = api.getTags();
            assert.strictEqual(
                tagsAfter.size,
                0,
                'tags.yml at a non-existent path should leave the loader empty',
            );

            // The completion provider should still surface cache-discovered
            // tags (and their implicit parents), just not yaml-defined ones.
            const doc = await vscode.workspace.openTextDocument(sampleUri);
            await vscode.window.showTextDocument(doc);
            const lastLine = doc.lineCount - 1;
            const insertPos = new vscode.Position(lastLine, doc.lineAt(lastLine).text.length);
            const edit = new vscode.WorkspaceEdit();
            edit.insert(sampleUri, insertPos, '\n- [ ] x #');
            await vscode.workspace.applyEdit(edit);
            const newLine = lastLine + 1;
            const newText = doc.lineAt(newLine).text;
            const triggerPos = new vscode.Position(newLine, newText.length);

            const list = await completionAt(sampleUri, triggerPos);
            const labels = list.items.map((i) =>
                typeof i.label === 'string' ? i.label : i.label.label,
            );

            assert.ok(labels.includes('project/tsk'), 'cache-discovered project/tsk still present');
            assert.ok(
                !labels.includes('yaml-only-not-in-tsk'),
                'yaml-only tag should NOT surface once tags.yml is missing',
            );

            // Cache-discovered items have no `detail` (no yaml description).
            const projectTsk = list.items.find(
                (i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'project/tsk',
            );
            assert.ok(projectTsk);
            assert.strictEqual(
                projectTsk.detail,
                undefined,
                'cache-discovered items have no description',
            );

            const undo = new vscode.WorkspaceEdit();
            undo.delete(
                sampleUri,
                new vscode.Range(
                    new vscode.Position(lastLine, doc.lineAt(lastLine).text.length),
                    new vscode.Position(newLine, newText.length),
                ),
            );
            await vscode.workspace.applyEdit(undo);
        } finally {
            await config().update(TAGS_PATH_KEY, original, vscode.ConfigurationTarget.Workspace);
            await api.reloadTags();
        }
    });

    test('contributes.configuration declares tsk.tags.path with the documented default', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const props = ext.packageJSON.contributes.configuration.properties as Record<
            string,
            { type: string; default: string; description: string }
        >;
        const entry = props['tsk.tags.path'];
        assert.ok(entry, 'tsk.tags.path should be a contributed setting');
        assert.strictEqual(entry.type, 'string');
        assert.strictEqual(entry.default, '${workspaceFolder}/.vscode/tsk/tags.yml');
    });
});
