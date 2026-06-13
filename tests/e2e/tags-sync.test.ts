import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';

/**
 * `tsk.addDiscoveredTags` e2e. Points `tsk.tags.path` at a temp file in the
 * workspace (so the committed fixture `tags.yml` is untouched), writes a `.tsk`
 * file carrying unique tags, rebuilds the cache, runs the command, and asserts
 * the temp `tags.yml` gained bare stubs under a dated header while existing
 * entries survive. Config + temp files are restored in teardown.
 */
suite('add discovered tags to tags.yml', () => {
    let api: TskExtensionApi;
    let workspaceUri: vscode.Uri;
    const created: vscode.Uri[] = [];
    const config = () => vscode.workspace.getConfiguration('tsk');
    let origTagsPath: string | undefined;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'a workspace folder is required for this suite');
        workspaceUri = folder.uri;
        origTagsPath = config().inspect<string>('tags.path')?.workspaceValue;
    });

    teardown(async () => {
        await config().update('tags.path', origTagsPath, vscode.ConfigurationTarget.Workspace);
        for (const uri of created.splice(0)) {
            // Revert any unsaved edits the command left so deletion doesn't prompt.
            try {
                await vscode.window.showTextDocument(uri);
                await vscode.commands.executeCommand('workbench.action.files.revert');
            } catch {
                /* not open */
            }
            try {
                await vscode.workspace.fs.delete(uri);
            } catch {
                /* already gone */
            }
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        // Drop the temp task file's tags from the cache before the next suite.
        await vscode.commands.executeCommand('tsk.rebuildCache');
    });

    async function writeFile(name: string, content: string): Promise<vscode.Uri> {
        const uri = vscode.Uri.joinPath(workspaceUri, name);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        created.push(uri);
        return uri;
    }

    // Read the editor BUFFER: the command leaves tags.yml dirty/unsaved (like
    // mark-now / move), so fs.readFile would miss the unsaved WorkspaceEdit.
    const read = async (uri: vscode.Uri): Promise<string> =>
        (await vscode.workspace.openTextDocument(uri)).getText();

    async function pointAtTagsFile(uri: vscode.Uri): Promise<void> {
        await config().update('tags.path', uri.fsPath, vscode.ConfigurationTarget.Workspace);
    }

    test('appends discovered-but-undeclared tags as bare stubs under a dated header', async () => {
        const tagsYml = await writeFile('sync-tags.yml', 'synctag-declared: an existing entry\n');
        await writeFile(
            'sync-tasks.tsk',
            '- [ ] sync task <!-- @id:sync-task-1 --> #synctag-declared #synctag-alpha #synctag-beta/child\n',
        );
        await pointAtTagsFile(tagsYml);
        await vscode.commands.executeCommand('tsk.rebuildCache');

        await vscode.commands.executeCommand('tsk.addDiscoveredTags');

        const text = await read(tagsYml);
        assert.match(text, /# discovered \d{4}-\d{2}-\d{2} — fill in description \/ parent/);
        assert.ok(
            text.includes('synctag-declared: an existing entry'),
            'the existing declaration is preserved verbatim',
        );
        assert.match(text, /^synctag-alpha:$/m, 'a fresh literal tag is appended as a bare stub');
        assert.match(text, /^synctag-beta\/child:$/m, 'a fresh hierarchical tag is appended');
        assert.doesNotMatch(
            text,
            /^synctag-beta:$/m,
            'the implicit parent (synctag-beta) is NOT added — literal tags only',
        );
        assert.strictEqual(
            (text.match(/synctag-declared/g) ?? []).length,
            1,
            'an already-declared tag is not re-added',
        );

        // The loader (and the test API) see the stubs after the command's reload.
        assert.ok(api.getTags().has('synctag-alpha'), 'getTags reflects the appended stub');
    });

    test('re-running adds nothing once everything is declared (idempotent)', async () => {
        const tagsYml = await writeFile('sync-tags2.yml', '# header comment\n');
        await writeFile('sync-tasks2.tsk', '- [ ] t <!-- @id:sync-task-2 --> #synctag-idem\n');
        await pointAtTagsFile(tagsYml);
        await vscode.commands.executeCommand('tsk.rebuildCache');

        await vscode.commands.executeCommand('tsk.addDiscoveredTags');
        const afterFirst = await read(tagsYml);
        assert.match(afterFirst, /^synctag-idem:$/m, 'first run appended the tag');

        await vscode.commands.executeCommand('tsk.addDiscoveredTags');
        const afterSecond = await read(tagsYml);
        assert.strictEqual(afterSecond, afterFirst, 'second run changes nothing');
        // The header comment from the original file is still intact.
        assert.ok(afterSecond.startsWith('# header comment\n'), 'leading comment preserved');
    });

    test('creates tags.yml when the configured path does not exist yet', async () => {
        const tagsYml = vscode.Uri.joinPath(workspaceUri, 'sync-new.yml');
        created.push(tagsYml); // ensure teardown removes it even though we never wrote it
        await writeFile('sync-tasks3.tsk', '- [ ] t <!-- @id:sync-task-3 --> #synctag-created\n');
        await pointAtTagsFile(tagsYml);
        await vscode.commands.executeCommand('tsk.rebuildCache');

        await vscode.commands.executeCommand('tsk.addDiscoveredTags');

        const text = await read(tagsYml);
        assert.match(text, /# discovered \d{4}-\d{2}-\d{2}/);
        assert.match(text, /^synctag-created:$/m);
    });

    test('a blank tsk.tags.path is a no-op (no throw, no write)', async () => {
        await config().update('tags.path', '', vscode.ConfigurationTarget.Workspace);
        // Should resolve cleanly (info toast, no file touched).
        await vscode.commands.executeCommand('tsk.addDiscoveredTags');
        assert.ok(true, 'command resolved without throwing when no path is configured');
    });
});
