import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Find-all-tasks-by-tag e2e. The runtime path is intentionally NOT
 * exercised here — QuickPick UI + `workbench.action.findInFiles` aren't
 * easily intercepted from `@vscode/test-cli`, and the spec hands UX
 * trust off to VSCode's Search Editor. What we *can* drift-detect:
 *
 *  - The command is contributed and registered.
 *  - The Alt+T keybinding is gated to `.tsk` editors with text focus.
 *
 * The pure logic that builds the QuickPick rows + `findInFiles` args is
 * covered exhaustively in `src/lib/tags-find-logic.test.ts` (vitest).
 */
suite('find all tasks by tag', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
    });

    test('tsk.findAllTasksByTag is contributed and registered', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const commands = ext.packageJSON.contributes.commands as ReadonlyArray<{
            command: string;
            title: string;
            category?: string;
        }>;
        const contributed = commands.find((c) => c.command === 'tsk.findAllTasksByTag');
        assert.ok(contributed, 'tsk.findAllTasksByTag should be contributed');
        assert.strictEqual(contributed.title, 'Find All Tasks by Tag');
        assert.strictEqual(contributed.category, 'Tsk');

        const registered = await vscode.commands.getCommands(true);
        assert.ok(
            registered.includes('tsk.findAllTasksByTag'),
            'tsk.findAllTasksByTag should be registered with the runtime',
        );
    });

    test('contributes.keybindings registers Alt+T gated to tsk + editor focus', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const keybindings = ext.packageJSON.contributes.keybindings as ReadonlyArray<{
            command: string;
            key: string;
            when: string;
        }>;
        const binding = keybindings.find((k) => k.command === 'tsk.findAllTasksByTag');
        assert.ok(binding, 'tsk.findAllTasksByTag should have a keybinding');
        assert.strictEqual(binding.key, 'alt+t');
        assert.match(binding.when, /editorLangId == 'tsk'/);
        assert.match(binding.when, /editorTextFocus/);
    });

    test('the Search Editor command we dispatch to exists in this VS Code host', async () => {
        // M21/D switched find-by-tag from the side panel to the Search
        // Editor. `search.action.openNewEditor` is the command we fire on
        // pick — verify it's actually registered, so a future VS Code
        // rename (or the 1.112 floor missing it) fails loudly here rather
        // than silently no-op'ing the user's pick. Runs on both the
        // `stable` and `floor` (1.112) e2e configs.
        const registered = await vscode.commands.getCommands(true);
        assert.ok(
            registered.includes('search.action.openNewEditor'),
            'search.action.openNewEditor must exist for find-by-tag to open the Search Editor',
        );
    });
});
