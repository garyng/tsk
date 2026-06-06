import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { CLIPBOARD_BRIDGE_PATH_KEY, COMMANDS } from './constants';
import {
    bridgeDisplayPath,
    buildClipboardBridgeSkillContent,
    CLIPBOARD_BRIDGE_SKILL_NAME,
    CLIPBOARD_BRIDGE_SKILL_REL_PATH,
    resolveSkillInstallPath,
} from './lib/clipboard-bridge-skill';
import type { Logger } from './lib/logger';

/**
 * Build the skill content (with the workspace's configured bridge path
 * baked in) and write it to `targetAbsPath`, creating parent dirs. The
 * side-effect half of the install command, factored out so the e2e can
 * exercise the write without driving the command's input box (UI prompts
 * aren't replayable through `executeCommand`).
 */
export function writeClipboardBridgeSkill(
    targetAbsPath: string,
    rawBridgePath: string,
    workspaceFolder: string,
): void {
    const content = buildClipboardBridgeSkillContent(
        bridgeDisplayPath(rawBridgePath, workspaceFolder),
    );
    mkdirSync(dirname(targetAbsPath), { recursive: true });
    writeFileSync(targetAbsPath, content, 'utf8');
}

/**
 * Register `tsk.installClipboardBridgeSkill`. Prompts for an install path
 * (defaulting to `.claude/skills/tsk-clipboard-bridge/SKILL.md`), then
 * writes the clipboard-bridge skill there with this workspace's configured
 * watch-file path baked in. Prompts again before overwriting an existing
 * file.
 *
 * Why install into the workspace rather than ship it globally: Claude Code
 * discovers skills per-workspace under `.claude/skills/`, and the skill's
 * content is workspace-specific (it names *this* workspace's configured
 * bridge path). A command that materializes it on demand keeps the
 * extension from writing into the user's project uninvited — and the path
 * prompt lets the user redirect it (a nested `.claude`, a scratch
 * location) without hand-editing settings.
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

            const input = await vscode.window.showInputBox({
                title: 'Install Clipboard Bridge Skill',
                prompt: 'Where to write the skill — relative to the workspace folder, or an absolute path.',
                value: CLIPBOARD_BRIDGE_SKILL_REL_PATH,
                validateInput: (v) => (v.trim() === '' ? 'Enter a path.' : undefined),
            });
            if (input === undefined) {
                logger.debug(`${COMMANDS.installClipboardBridgeSkill}: cancelled at path prompt`);
                return;
            }

            const target = resolveSkillInstallPath(input, workspaceFolder);

            if (existsSync(target)) {
                // Non-modal confirmation toast (not a blocking modal): click
                // "Overwrite" to proceed, dismiss to cancel.
                const choice = await vscode.window.showWarningMessage(
                    `Tsk: ${input.trim()} already exists. Overwrite it?`,
                    'Overwrite',
                );
                if (choice !== 'Overwrite') {
                    logger.debug(`${COMMANDS.installClipboardBridgeSkill}: declined overwrite`);
                    return;
                }
            }

            // Throwaway '' fallback — the package.json default is returned for
            // this contributed setting (single source of truth for the path).
            const rawPath = vscode.workspace
                .getConfiguration('tsk')
                .get<string>(CLIPBOARD_BRIDGE_PATH_KEY, '');
            try {
                writeClipboardBridgeSkill(target, rawPath, workspaceFolder);
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
