import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Find-all-tasks-by-status e2e (M6 — the marker sibling of find-by-tag). The
 * runtime path (QuickPick → Search Editor) isn't driven here for the same reason
 * as find-by-tag (QuickPick UI can't be replayed via `executeCommand`); the pure
 * QuickPick-row + line-anchored regex-arg logic is covered exhaustively in
 * `src/lib/markers-find-logic.test.ts` (vitest). What we drift-detect here:
 *
 *  - The command is contributed (palette entry) and registered.
 *  - It deliberately has NO keybinding (Alt+T is taken by the tag search).
 *
 * The Search Editor command it dispatches to (`search.action.openNewEditor`) is
 * already host-checked by the find-by-tag suite.
 */
suite('find all tasks by status', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
    });

    test('tsk.findAllTasksByStatus is contributed and registered', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const commands = ext.packageJSON.contributes.commands as ReadonlyArray<{
            command: string;
            title: string;
            category?: string;
        }>;
        const contributed = commands.find((c) => c.command === 'tsk.findAllTasksByStatus');
        assert.ok(contributed, 'tsk.findAllTasksByStatus should be contributed');
        assert.strictEqual(contributed.title, 'Find All Tasks by Status');
        assert.strictEqual(contributed.category, 'Tsk');

        const registered = await vscode.commands.getCommands(true);
        assert.ok(
            registered.includes('tsk.findAllTasksByStatus'),
            'tsk.findAllTasksByStatus should be registered with the runtime',
        );
    });

    test('is palette-only — no keybinding (Alt+T is the tag search)', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const keybindings = (ext.packageJSON.contributes.keybindings ?? []) as ReadonlyArray<{
            command: string;
        }>;
        const binding = keybindings.find((k) => k.command === 'tsk.findAllTasksByStatus');
        assert.strictEqual(binding, undefined, 'find-by-status should not contribute a keybinding');
    });
});
