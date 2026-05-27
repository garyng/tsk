import * as vscode from 'vscode';
import type { Logger } from './lib/logger';
import {
    defaultToggleDeps,
    type ToggleDeps,
    toggleCancelledMutator,
    toggleCompletedMutator,
    toggleInprogressMutator,
    toggleNoteMutator,
    toggleTodoMutator,
} from './lib/toggle-mutators';

const TSK_LANGUAGE_ID = 'tsk';

type LineMutator = (line: string) => string;

/**
 * Run `mutator(line)` once per unique cursor line in `editor`, build a
 * single `WorkspaceEdit` covering all the replacements, and apply it in
 * one shot. One Ctrl+Z reverts the whole operation.
 *
 * Multi-cursor handling: cursors on the same line are deduped (one edit
 * per unique line) — toggling a marker with two cursors on the same row
 * doesn't double-apply and cancel itself. Cursors whose mutator returns
 * the unchanged line are skipped + logged at debug.
 *
 * Returns the number of line replacements applied (0 = no edits, useful
 * for callers that want to know whether the action was a complete no-op).
 */
export async function applyEdit(
    editor: vscode.TextEditor,
    mutator: LineMutator,
    logger?: Logger,
): Promise<number> {
    if (editor.document.languageId !== TSK_LANGUAGE_ID) {
        logger?.debug(
            `applyEdit: skipped — language id is "${editor.document.languageId}", not "${TSK_LANGUAGE_ID}"`,
        );
        return 0;
    }
    const doc = editor.document;
    const uniqueLines = new Set<number>();
    for (const selection of editor.selections) {
        uniqueLines.add(selection.active.line);
    }
    const edit = new vscode.WorkspaceEdit();
    let applied = 0;
    for (const lineNumber of uniqueLines) {
        const lineText = doc.lineAt(lineNumber).text;
        const next = mutator(lineText);
        if (next === lineText) {
            logger?.debug(`applyEdit: line ${lineNumber + 1} no-op (mutator returned unchanged)`);
            continue;
        }
        edit.replace(doc.uri, new vscode.Range(lineNumber, 0, lineNumber, lineText.length), next);
        applied++;
    }
    if (applied === 0) return 0;
    await vscode.workspace.applyEdit(edit);
    return applied;
}

/**
 * Register every M5/B marker-toggle command. Each command captures the
 * mutator + deps via closure so the dispatcher is just "find the active
 * editor and run `applyEdit`".
 *
 * The `deps` parameter exists for tests that want to substitute fake
 * `generateId` / `now` factories; the default wires `defaultToggleDeps`
 * (real `nanoid` + `localTimestamp`).
 */
export function registerToggleCommands(
    context: vscode.ExtensionContext,
    logger: Logger,
    deps: ToggleDeps = defaultToggleDeps,
): void {
    const bind =
        (m: (line: string, deps: ToggleDeps) => string): LineMutator =>
        (line) =>
            m(line, deps);

    const commands: ReadonlyArray<[string, LineMutator]> = [
        ['tsk.toggleTodo', bind(toggleTodoMutator)],
        ['tsk.toggleInprogress', bind(toggleInprogressMutator)],
        ['tsk.toggleCompleted', bind(toggleCompletedMutator)],
        ['tsk.toggleCancelled', bind(toggleCancelledMutator)],
        ['tsk.toggleNote', bind(toggleNoteMutator)],
    ];

    for (const [id, mutator] of commands) {
        context.subscriptions.push(
            vscode.commands.registerCommand(id, async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    logger.debug(`${id}: no active editor`);
                    return;
                }
                await applyEdit(editor, mutator, logger);
            }),
        );
    }
}
