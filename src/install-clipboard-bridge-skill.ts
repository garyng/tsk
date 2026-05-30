import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { CLIPBOARD_BRIDGE_PATH_KEY, COMMANDS, DEFAULT_CLIPBOARD_BRIDGE_PATH } from './constants';
import {
    bridgeDisplayPath,
    buildClipboardBridgeSkillContent,
    CLIPBOARD_BRIDGE_SKILL_NAME,
    CLIPBOARD_BRIDGE_SKILL_REL_PATH,
} from './lib/clipboard-bridge-skill';
import type { Logger } from './lib/logger';

/**
 * Register `tsk.installClipboardBridgeSkill`. Writes the clipboard-bridge
 * skill into the workspace's `.claude/skills/` so Claude Code discovers
 * it, with the configured watch-file path baked in. Prompts before
 * overwriting an existing copy.
 *
 * Why install into the workspace rather than ship it globally: Claude Code
 * discovers skills per-workspace under `.claude/skills/`, and the skill's
 * content is workspace-specific (it names *this* workspace's configured
 * bridge path). A command that materializes it on demand keeps the
 * extension from writing into the user's project uninvited.
 */
export function registerInstallClipboardBridgeSkillCommand(
    context: vscode.ExtensionContext,
    logger: Logger,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.installClipboardBridgeSkill, async () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceFolder) {
                void vscode.window.showWarningMessage(
                    'Tsk: open a workspace folder before installing the clipboard-bridge skill.',
                );
                return;
            }

            const rawPath = vscode.workspace
                .getConfiguration('tsk')
                .get<string>(CLIPBOARD_BRIDGE_PATH_KEY, DEFAULT_CLIPBOARD_BRIDGE_PATH);
            const content = buildClipboardBridgeSkillContent(
                bridgeDisplayPath(rawPath, workspaceFolder),
            );
            const target = join(workspaceFolder, CLIPBOARD_BRIDGE_SKILL_REL_PATH);

            if (existsSync(target)) {
                const choice = await vscode.window.showWarningMessage(
                    `Tsk: ${CLIPBOARD_BRIDGE_SKILL_REL_PATH} already exists. Overwrite it?`,
                    { modal: true },
                    'Overwrite',
                );
                if (choice !== 'Overwrite') {
                    logger.debug(`${COMMANDS.installClipboardBridgeSkill}: declined overwrite`);
                    return;
                }
            }

            try {
                mkdirSync(dirname(target), { recursive: true });
                writeFileSync(target, content, 'utf8');
            } catch (err) {
                const message = (err as Error).message;
                logger.error(`${COMMANDS.installClipboardBridgeSkill}: write failed: ${message}`);
                void vscode.window.showErrorMessage(`Tsk: failed to install skill — ${message}`);
                return;
            }

            logger.info(`${COMMANDS.installClipboardBridgeSkill}: wrote ${target}`);
            // Fire-and-forget the success toast: don't block the command on
            // the user dismissing a non-modal notification (it would also
            // hang the e2e host, where notifications never auto-resolve).
            void vscode.window
                .showInformationMessage(
                    `Tsk: installed the ${CLIPBOARD_BRIDGE_SKILL_NAME} skill. Reload Claude Code to pick it up.`,
                    'Open skill',
                )
                .then(async (open) => {
                    if (open !== 'Open skill') return;
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
                    await vscode.window.showTextDocument(doc);
                });
        }),
    );
}
