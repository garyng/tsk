import * as vscode from 'vscode';
import { COMMANDS } from './constants';
import { isTskDocument } from './editor-guards';
import type { Logger } from './lib/logger';
import { refreshTaskIdentity } from './lib/toggle';
import { defaultToggleDeps, type ToggleDeps } from './lib/toggle-mutators';

/**
 * Register `tsk.duplicateLineDown` / `tsk.duplicateLineUp`, bound to
 * Shift+Alt+Down / Shift+Alt+Up in `.tsk` files (shadowing the built-in line
 * duplication only there).
 *
 * **Why wrap the built-in instead of reimplementing.** `editor.action.
 * copyLines{Down,Up}Action` already owns every duplication mechanic — multi-
 * cursor, column selections, scroll reveal. We run it verbatim, then rewrite
 * the `@id` + `@created` of each *copied* task line so the duplicate doesn't
 * collide with its source on the cache primary key. The catch is that this is a
 * **second** edit, so it costs a second Ctrl+Z (accepted — decision #1 in the
 * Phase 4 plan). The upside: multi-cursor duplication "just works", because the
 * post-command selection is exactly the set of freshly-created copies.
 *
 * `deps` is injected for tests; the default wires the real nanoid + timestamp.
 */
export function registerDuplicateCommands(
    context: vscode.ExtensionContext,
    logger: Logger,
    deps: ToggleDeps = defaultToggleDeps,
): void {
    const register = (commandId: string, builtin: string): void => {
        context.subscriptions.push(
            vscode.commands.registerCommand(commandId, () =>
                duplicateAndRefresh(commandId, builtin, deps, logger),
            ),
        );
    };
    register(COMMANDS.duplicateLineDown, 'editor.action.copyLinesDownAction');
    register(COMMANDS.duplicateLineUp, 'editor.action.copyLinesUpAction');
}

async function duplicateAndRefresh(
    commandId: string,
    builtin: string,
    deps: ToggleDeps,
    logger: Logger,
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    // Run the built-in duplicate first — it owns the mechanics. We only
    // post-process `.tsk` documents; everywhere else this is a pure passthrough.
    await vscode.commands.executeCommand(builtin);
    if (!editor || !isTskDocument(editor.document)) return;

    // After copyLines{Down,Up}, the selections cover the freshly-created copies
    // (the built-in moves the selection onto them). Rewrite the identity of each
    // unique copied line that parses as a task, in a single WorkspaceEdit so the
    // id refresh is one extra undo step rather than one-per-line.
    const doc = editor.document;
    const uniqueLines = new Set<number>();
    for (const selection of editor.selections) {
        for (let line = selection.start.line; line <= selection.end.line; line++) {
            uniqueLines.add(line);
        }
    }

    const edit = new vscode.WorkspaceEdit();
    let rewritten = 0;
    for (const lineNumber of uniqueLines) {
        const lineText = doc.lineAt(lineNumber).text;
        const next = refreshTaskIdentity(lineText, deps);
        if (next === lineText) continue;
        edit.replace(doc.uri, new vscode.Range(lineNumber, 0, lineNumber, lineText.length), next);
        rewritten++;
    }
    if (rewritten > 0) {
        await vscode.workspace.applyEdit(edit);
    }
    logger.debug(`${commandId}: refreshed @id on ${rewritten} duplicated task line(s)`);
}
