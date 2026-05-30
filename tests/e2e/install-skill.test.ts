import * as assert from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';
const SKILL_REL = '.claude/skills/tsk-clipboard-bridge/SKILL.md';

/**
 * Install-skill command e2e (M22 follow-up). Drives
 * `tsk.installClipboardBridgeSkill` and asserts it materializes the skill
 * into the workspace's `.claude/skills/` with the configured bridge path
 * baked in.
 *
 * Cleanup: the command writes into the fixture workspace. We track whether
 * `.claude` existed before and remove what we created in `finally` so the
 * fixture stays clean across runs.
 */
suite('install clipboard-bridge skill command', () => {
    let workspaceFolder: string;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'expected a workspace folder');
        workspaceFolder = folder.uri.fsPath;
    });

    test('writes the skill with the configured bridge path baked in', async () => {
        const claudeDir = join(workspaceFolder, '.claude');
        const claudeExistedBefore = existsSync(claudeDir);
        const target = join(workspaceFolder, SKILL_REL);
        // Start clean so the command writes directly (no overwrite dialog).
        rmSync(join(workspaceFolder, '.claude', 'skills', 'tsk-clipboard-bridge'), {
            recursive: true,
            force: true,
        });

        try {
            await vscode.commands.executeCommand('tsk.installClipboardBridgeSkill');

            assert.ok(existsSync(target), `expected the skill at ${SKILL_REL}`);
            const content = readFileSync(target, 'utf8');
            assert.match(content, /^---\nname: tsk-clipboard-bridge\n/);
            // Fixture has no custom bridgePath → default resolves to the
            // workspace-relative .vscode/tsk/clipboard-bridge.txt.
            assert.ok(
                content.includes('.vscode/tsk/clipboard-bridge.txt'),
                'skill should reference the resolved bridge path',
            );
        } finally {
            if (claudeExistedBefore) {
                rmSync(join(workspaceFolder, '.claude', 'skills', 'tsk-clipboard-bridge'), {
                    recursive: true,
                    force: true,
                });
            } else {
                rmSync(claudeDir, { recursive: true, force: true });
            }
        }
    });

    test('tsk.installClipboardBridgeSkill is contributed and registered', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const commands = ext.packageJSON.contributes.commands as ReadonlyArray<{
            command: string;
            title: string;
            category?: string;
        }>;
        const contributed = commands.find((c) => c.command === 'tsk.installClipboardBridgeSkill');
        assert.ok(contributed, 'command should be contributed');
        assert.strictEqual(contributed.title, 'Install Clipboard Bridge Skill');
        assert.strictEqual(contributed.category, 'Tsk');

        const registered = await vscode.commands.getCommands(true);
        assert.ok(
            registered.includes('tsk.installClipboardBridgeSkill'),
            'command should be registered with the runtime',
        );
    });
});
