import * as vscode from 'vscode';
import { TSK_LANGUAGE_ID } from './constants';
import { generateId } from './lib/ids';
import { parseLine } from './lib/parser';
import { localTimestamp } from './lib/time';
import { promoteMissingMetadata } from './lib/toggle';

/**
 * Dependencies the code-action provider needs to mint fresh `@id` and
 * `@created` values. Injectable so tests can pass deterministic factories;
 * the activation layer wires in the real `nanoid` + `localTimestamp`.
 */
export interface CodeActionDeps {
    generateId: () => string;
    now: () => string;
}

const defaultDeps: CodeActionDeps = {
    generateId,
    now: localTimestamp,
};

/**
 * Register a `QuickFix` provider that surfaces "Tsk: Add missing id +
 * created" on any markered task line whose metadata lacks `@id`. The
 * action's edit is the same one the M19/A toggle mutator applies, via
 * the shared {@link promoteMissingMetadata} helper.
 *
 * **Marker-agnostic.** The lightbulb appears for any markered task —
 * `- [ ]`, `- [/]`, `- [x]`, `- [n]`, etc. — as long as `@id` is
 * missing. Alt+A is gated on a specific marker; the code action is more
 * permissive so a user can promote a hand-typed `- [x] done` in place
 * without first cycling through `Alt+A` + `Alt+C`.
 *
 * Title varies by whether `@created` is also missing:
 *   - both `@id` + `@created` missing → "Tsk: Add missing id + created"
 *   - only `@id` missing                → "Tsk: Add missing id"
 *
 * The edit is precomputed at `provideCodeActions` time (rather than
 * deferred via a command). `nanoid` is cheap enough that generating a
 * throw-away id per lightbulb refresh is unmeasurable.
 */
export function registerCodeActionsProvider(
    context: vscode.ExtensionContext,
    deps: CodeActionDeps = defaultDeps,
): void {
    const provider: vscode.CodeActionProvider = {
        provideCodeActions(document, range) {
            const lineNumber = range.start.line;
            const lineText = document.lineAt(lineNumber).text;
            const parsed = parseLine(lineText);
            if (!parsed || parsed.metadata.has('id')) return undefined;

            const next = promoteMissingMetadata(lineText, deps);
            if (next === null) return undefined;

            const title = parsed.metadata.has('created')
                ? 'Tsk: Add missing id'
                : 'Tsk: Add missing id + created';
            const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(lineNumber, 0, lineNumber, lineText.length),
                next,
            );
            action.edit = edit;
            return [action];
        },
    };

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider({ language: TSK_LANGUAGE_ID }, provider, {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
        }),
    );
}
