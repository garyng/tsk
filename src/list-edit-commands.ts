import * as vscode from 'vscode';
import {
    computeEnterEdit,
    computeShiftTabEdit,
    computeTabEdit,
    type EditorOpts,
    type ListEditAction,
} from './lib/list-edit';
import type { Logger } from './lib/logger';
import { defaultToggleDeps, type ToggleDeps } from './lib/toggle-mutators';

const TSK_LANGUAGE_ID = 'tsk';

/**
 * Register the three M7 list-edit commands (`tsk.handleEnter` /
 * `tsk.handleTab` / `tsk.handleShiftTab`). Each intercepts the
 * corresponding keypress in `.tsk` files via a keybinding gated by
 * `editorLangId == 'tsk' && editorTextFocus && !suggestWidgetVisible &&
 * !inSnippetMode`. The pure helpers in `lib/list-edit.ts` decide the
 * edit; this layer translates the result into a `WorkspaceEdit` (single
 * Ctrl+Z reverts) and repositions the cursor. On a `noop` result, we
 * fall through to the editor's default key behavior.
 *
 * `deps` exists for tests (M7/C drives the suite); defaults to
 * `defaultToggleDeps` (real `generateId` + `localTimestamp`). Used by
 * Enter to populate `@id` + `@created` on the continuation line.
 */
export function registerListEditCommands(
    context: vscode.ExtensionContext,
    logger: Logger,
    deps: ToggleDeps = defaultToggleDeps,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('tsk.handleEnter', () => handleEnter(logger, deps)),
        vscode.commands.registerCommand('tsk.handleTab', () => handleTab(logger)),
        vscode.commands.registerCommand('tsk.handleShiftTab', () => handleShiftTab(logger)),
    );
}

async function handleEnter(logger: Logger, deps: ToggleDeps): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== TSK_LANGUAGE_ID) {
        await fallbackEnter();
        return;
    }
    const cursor = editor.selection.active;
    const lineText = editor.document.lineAt(cursor.line).text;
    const action = computeEnterEdit(lineText, cursor.character, editorOpts(editor), deps);
    if (action.kind === 'noop') {
        await fallbackEnter();
        return;
    }
    await applyListEditAction(editor, cursor.line, action);
    logger.debug(`tsk.handleEnter: ${action.kind} at line ${cursor.line + 1}`);
}

async function handleTab(logger: Logger): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== TSK_LANGUAGE_ID) {
        await vscode.commands.executeCommand('tab');
        return;
    }
    const cursor = editor.selection.active;
    const lineText = editor.document.lineAt(cursor.line).text;
    const action = computeTabEdit(lineText, cursor.character, editorOpts(editor));
    if (action.kind === 'noop') {
        await vscode.commands.executeCommand('tab');
        return;
    }
    await applyListEditAction(editor, cursor.line, action);
    logger.debug(`tsk.handleTab: ${action.kind} at line ${cursor.line + 1}`);
}

async function handleShiftTab(logger: Logger): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== TSK_LANGUAGE_ID) {
        await vscode.commands.executeCommand('editor.action.outdentLines');
        return;
    }
    const cursor = editor.selection.active;
    const lineText = editor.document.lineAt(cursor.line).text;
    const action = computeShiftTabEdit(lineText, cursor.character, editorOpts(editor));
    if (action.kind === 'noop') {
        await vscode.commands.executeCommand('editor.action.outdentLines');
        return;
    }
    await applyListEditAction(editor, cursor.line, action);
    logger.debug(`tsk.handleShiftTab: ${action.kind} at line ${cursor.line + 1}`);
}

/**
 * Read `insertSpaces` + `tabSize` off the editor. VSCode exposes both as
 * `boolean | string | number` (the string variants are deprecated, but
 * defending against them keeps us robust to upstream surprises).
 */
function editorOpts(editor: vscode.TextEditor): EditorOpts {
    const insertSpaces = editor.options.insertSpaces === true;
    const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;
    return { insertSpaces, tabSize };
}

/**
 * Apply a non-`noop` `ListEditAction` to the editor: build a single
 * `WorkspaceEdit` that replaces the affected line range, apply it, then
 * move the cursor to the new position. For `split-line`, the line range
 * is replaced with `firstText\nsecondText` (VSCode interprets `\n` as a
 * line break) and the cursor jumps to the second line.
 */
async function applyListEditAction(
    editor: vscode.TextEditor,
    lineNumber: number,
    action: ListEditAction,
): Promise<void> {
    if (action.kind === 'noop') return;

    const doc = editor.document;
    const lineRange = doc.lineAt(lineNumber).range;
    const edit = new vscode.WorkspaceEdit();

    if (action.kind === 'replace-line') {
        edit.replace(doc.uri, lineRange, action.text);
        await vscode.workspace.applyEdit(edit);
        const pos = new vscode.Position(lineNumber, action.cursorCol);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos));
        return;
    }

    edit.replace(doc.uri, lineRange, `${action.firstText}\n${action.secondText}`);
    await vscode.workspace.applyEdit(edit);
    const pos = new vscode.Position(lineNumber + 1, action.cursorCol);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos));
}

/**
 * Trigger the editor's default Enter behavior. `source: 'keyboard'` lets
 * downstream listeners (auto-indent, etc.) see the action as a real
 * keystroke, matching MD-AIO's pattern. We can't simply re-fire the
 * `enter` keybinding because that would loop back through our handler.
 */
async function fallbackEnter(): Promise<void> {
    await vscode.commands.executeCommand('type', { source: 'keyboard', text: '\n' });
}
