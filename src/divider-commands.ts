import * as vscode from 'vscode';
import { COMMANDS, DIVIDER_WIDTH_KEY } from './constants';
import { requireTskEditor } from './editor-guards';
import { dividerPlacement, formatDivider } from './lib/divider';
import type { Logger } from './lib/logger';

/**
 * `tsk.insertDivider` — prompt for a section label and write
 * `-<label>--------…` padded to `tsk.divider.width`.
 *
 * Also the rename/re-pad path: run it on an existing divider and the prompt
 * arrives prefilled with the current label, so fixing a typo doesn't mean
 * retyping a hundred hyphens.
 */
export function registerDividerCommands(context: vscode.ExtensionContext, logger: Logger): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.insertDivider, () => insertDivider(logger)),
    );
}

/**
 * The configured divider width, clamped to the setting's declared minimum (8).
 * Not a correctness guard — `formatDivider` emits a matchable line at any width.
 */
function readWidth(): number {
    const raw = vscode.workspace.getConfiguration('tsk').get<number>(DIVIDER_WIDTH_KEY, 100);
    return Number.isFinite(raw) ? Math.max(8, Math.trunc(raw)) : 100;
}

async function insertDivider(logger: Logger): Promise<void> {
    const editor = requireTskEditor(logger, COMMANDS.insertDivider);
    if (!editor) return;

    const { document, selection } = editor;
    const line = selection.active.line;
    const placement = dividerPlacement(document.lineAt(line).text);

    const label = await vscode.window.showInputBox({
        prompt: 'Divider label',
        value: placement.existingLabel ?? '',
        placeHolder: 'todo',
        validateInput: (value) =>
            /^[A-Za-z0-9][\w/ -]*$/.test(value.trim())
                ? undefined
                : 'Start with a letter or digit; letters, digits, spaces, /, - and _ after.',
    });
    if (label === undefined) {
        logger.debug(`${COMMANDS.insertDivider}: cancelled`);
        return;
    }

    const text = formatDivider(label, readWidth());
    const edit = new vscode.WorkspaceEdit();
    if (placement.mode === 'replace') {
        edit.replace(document.uri, document.lineAt(line).range, text);
    } else {
        edit.insert(document.uri, document.lineAt(line).range.end, `\n${text}`);
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
        void vscode.window.showWarningMessage('Tsk: could not insert the divider.');
        return;
    }
    logger.info(`${COMMANDS.insertDivider}: ${placement.mode} "${label.trim()}"`);
}
