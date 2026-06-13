import * as vscode from 'vscode';
import { COMMANDS, DOUBLE_CLICK_SELECTS_BLOCK_KEY } from './constants';
import { isTskDocument, requireTskEditor } from './editor-guards';
import { mouseSelectionInPrefix } from './lib/block-select';
import type { Logger } from './lib/logger';
import { computeBlockDeletion, computeTaskBlockRange } from './lib/move-task-logic';
import { parseLine } from './lib/parser';
import { taskContentRange } from './lib/toggle';

/**
 * Task-block convenience gestures — operations that act on a task's whole
 * *block* (the task line + every line indented beneath it), reusing the
 * block-range machinery from Move/Extract (`computeTaskBlockRange` /
 * `computeBlockDeletion`).
 *
 * - `tsk.copyTaskBlock` / `tsk.cutTaskBlock` **shadow** VS Code's copy/cut in
 *   `.tsk` files so that — with nothing selected and a single cursor on a task
 *   line — the whole block is copied/cut, not just the one line the built-in
 *   "copy line" would take. Every other case (a real selection, multiple
 *   cursors, a non-task line, a non-tsk doc) falls straight through to the
 *   native action, the same way `duplicate-commands.ts` defers to the built-in.
 *   Calling the native command *by id* via `executeCommand` does not re-enter
 *   our keybinding, so there is no recursion.
 * - `tsk.selectTaskBlock` selects the block under the cursor — the deterministic,
 *   keyboard-accessible backbone that the double-click gesture also routes
 *   through (via the shared {@link selectBlockAt}).
 * - A selection-change listener (`onMouseSelection` → {@link blockExpandTarget})
 *   turns a **double-click on a task's marker / indentation** into a block
 *   selection (content double-clicks still select a word), gated by the default-on
 *   `tsk.doubleClickSelectsBlock` setting.
 */

/** The active editor's tab width (block indent is column-aware); 4 by default. */
function tabSizeOf(editor: vscode.TextEditor): number {
    return typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;
}

/** The document's line terminator, so clipboard EOLs match the file. */
function eolOf(doc: vscode.TextDocument): string {
    return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

export function registerBlockCommands(context: vscode.ExtensionContext, logger: Logger): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.copyTaskBlock, () =>
            clipboardBlock(false, logger),
        ),
        vscode.commands.registerCommand(COMMANDS.cutTaskBlock, () => clipboardBlock(true, logger)),
        vscode.commands.registerCommand(COMMANDS.selectTaskBlock, () => selectTaskBlock(logger)),
        // Double-click a task's marker / indent → select its block (marker-scoped,
        // so double-clicking the content still selects a word). Setting-gated.
        vscode.window.onDidChangeTextEditorSelection(onMouseSelection),
    );
}

/**
 * Select the whole task block at `line` (the task + its indented sub-items) and
 * reveal it. The shared primitive behind `tsk.selectTaskBlock` and the
 * double-click gesture — both start from a line and want it selected.
 */
function selectBlockAt(editor: vscode.TextEditor, line: number): void {
    const lines = editor.document.getText().split(/\r?\n/);
    const { start, end } = computeTaskBlockRange(lines, line, tabSizeOf(editor));
    const selection = new vscode.Selection(start, 0, end, editor.document.lineAt(end).text.length);
    editor.selection = selection;
    editor.revealRange(selection);
}

/** `tsk.selectTaskBlock` — select the block under the cursor (no-op off a task line). */
function selectTaskBlock(logger: Logger): void {
    const editor = requireTskEditor(logger, COMMANDS.selectTaskBlock);
    if (!editor) return;
    const line = editor.selection.active.line;
    if (!parseLine(editor.document.lineAt(line).text)) {
        void vscode.window.showInformationMessage('Tsk: the cursor is not on a task line.');
        return;
    }
    selectBlockAt(editor, line);
}

/**
 * Decide whether a mouse selection-change should expand to a block, and which
 * line — or `null` to leave the selection alone. Factored out of the listener so
 * every decision branch is testable WITHOUT a synthetic mouse event (the host
 * can't emit a `kind === Mouse` selection, so the listener is otherwise
 * unreachable from e2e). A double-click on the task's structural prefix (indent /
 * bullet / `[marker]`) expands; a double-click on its content — or any non-Mouse,
 * multi-, empty, or off-task selection — does not. See {@link mouseSelectionInPrefix}.
 */
export function blockExpandTarget(
    doc: vscode.TextDocument,
    selections: readonly vscode.Selection[],
    kind: vscode.TextEditorSelectionChangeKind | undefined,
    enabled: boolean,
): number | null {
    if (!enabled) return null;
    if (kind !== vscode.TextEditorSelectionChangeKind.Mouse) return null;
    if (!isTskDocument(doc)) return null;
    if (selections.length !== 1) return null;
    const [sel] = selections;
    if (!sel || sel.isEmpty || sel.start.line !== sel.end.line) return null;
    const content = taskContentRange(doc.lineAt(sel.start.line).text);
    if (!content) return null; // not a task line
    return mouseSelectionInPrefix(
        sel.start.line,
        sel.start.character,
        sel.end.line,
        sel.end.character,
        content.start,
    )
        ? sel.start.line
        : null;
}

/**
 * The selection-change listener behind double-click-selects-block. Reads the
 * (default-on) `tsk.doubleClickSelectsBlock` setting per event — cheap, and
 * keeps the manifest the single source of truth — then expands when
 * {@link blockExpandTarget} says so. The expansion sets `editor.selection`,
 * which re-fires this event with `kind === Command`/`undefined`; the kind filter
 * inside `blockExpandTarget` drops it, so there is no feedback loop.
 */
function onMouseSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    const enabled = vscode.workspace
        .getConfiguration('tsk')
        .get<boolean>(DOUBLE_CLICK_SELECTS_BLOCK_KEY, true);
    const line = blockExpandTarget(e.textEditor.document, e.selections, e.kind, enabled);
    if (line !== null) selectBlockAt(e.textEditor, line);
}

/**
 * Copy (or, when `isCut`, cut) the task block under the cursor. Defers to the
 * native clipboard action unless we're on a single empty cursor, on a task
 * line, in a `.tsk` document — so a real selection, multi-cursor, a non-task
 * line, or a non-tsk doc all behave exactly as the built-in would. The block's
 * *literal* lines go to the clipboard (no dedent — a cut→paste keeps the block's
 * shape); cut then deletes via `computeBlockDeletion` so no blank line is
 * orphaned, and copy leaves the block selected as visual confirmation.
 */
async function clipboardBlock(isCut: boolean, logger: Logger): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const native = isCut ? 'editor.action.clipboardCutAction' : 'editor.action.clipboardCopyAction';
    // The keybinding's `!editorHasSelection` already gates the has-selection
    // case off the key path; re-check here for the palette / `executeCommand`
    // path and for the multi-cursor / non-tsk cases.
    if (
        !editor ||
        !isTskDocument(editor.document) ||
        editor.selections.length !== 1 ||
        !editor.selection.isEmpty
    ) {
        await vscode.commands.executeCommand(native);
        return;
    }
    const doc = editor.document;
    const cursorLine = editor.selection.active.line;
    if (!parseLine(doc.lineAt(cursorLine).text)) {
        await vscode.commands.executeCommand(native); // not a task line → native line copy/cut
        return;
    }

    const lines = doc.getText().split(/\r?\n/);
    const { start, end } = computeTaskBlockRange(lines, cursorLine, tabSizeOf(editor));
    const blockText = lines.slice(start, end + 1).join(eolOf(doc));
    await vscode.env.clipboard.writeText(blockText);

    if (isCut) {
        const span = computeBlockDeletion(
            doc.lineCount,
            start,
            end,
            start > 0 ? doc.lineAt(start - 1).text.length : 0,
            doc.lineAt(end).text.length,
        );
        const edit = new vscode.WorkspaceEdit();
        edit.delete(
            doc.uri,
            new vscode.Range(span.startLine, span.startChar, span.endLine, span.endChar),
        );
        await vscode.workspace.applyEdit(edit);
    } else {
        // Leave the block selected — the literal "select the whole block and copy it".
        editor.selection = new vscode.Selection(start, 0, end, doc.lineAt(end).text.length);
    }
    logger.debug(`${isCut ? 'cutTaskBlock' : 'copyTaskBlock'}: ${end - start + 1} line(s)`);
}
