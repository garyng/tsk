import * as assert from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { writeClipboardBridgeSkill } from '../../src/install-clipboard-bridge-skill';

const EXTENSION_ID = 'garyng.tsk';
const SKILL_REL = '.claude/skills/tsk-clipboard-bridge/SKILL.md';

/**
 * Install-skill e2e (M22 follow-up). The command itself prompts for the
 * install path via an input box, which `executeCommand` can't replay
 * (same as the find-by-tag QuickPick), so we exercise the write half
 * directly through the exported `writeClipboardBridgeSkill` and only
 * drift-check the command's contribution/registration. Path resolution,
 * content, and bridge-path baking are covered by vitest in
 * `src/lib/clipboard-bridge-skill.test.ts`.
 *
 * Cleanup: this writes into the fixture workspace. We track whether
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

    test('writeClipboardBridgeSkill writes the skill with the configured bridge path baked in', () => {
        const claudeDir = join(workspaceFolder, '.claude');
        const claudeExistedBefore = existsSync(claudeDir);
        const target = join(workspaceFolder, SKILL_REL);

        try {
            // No custom bridgePath → '' resolves (via bridgeDisplayPath) to the
            // workspace-relative .vscode/tsk/clipboard-bridge.txt.
            writeClipboardBridgeSkill(target, '', workspaceFolder);

            assert.ok(existsSync(target), `expected the skill at ${SKILL_REL}`);
            const content = readFileSync(target, 'utf8');
            assert.match(content, /^---\nname: tsk-clipboard-bridge\n/);
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
