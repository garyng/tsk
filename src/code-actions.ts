import * as vscode from 'vscode';
import { INTERNAL_COMMANDS, TSK_LANGUAGE_ID } from './constants';
import type { CacheService } from './lib/cache';
import { generateId } from './lib/ids';
import type { Logger } from './lib/logger';
import { parseLine } from './lib/parser';
import { localTimestamp } from './lib/time';
import { promoteMissingMetadata, removeMetadataEntry, setMetadataEntry } from './lib/toggle';
import { pickTaskId } from './picker';

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

type BrokenRefKey = 'parent' | 'dependsOn' | 'relatedTo';

function brokenRefKey(diagnostic: vscode.Diagnostic): BrokenRefKey | undefined {
    const code = diagnostic.code;
    if (typeof code !== 'string' || !code.startsWith('broken-ref:')) return undefined;
    const key = code.slice('broken-ref:'.length);
    if (key === 'parent' || key === 'dependsOn' || key === 'relatedTo') return key;
    return undefined;
}

/**
 * Register the QuickFix provider plus the internal
 * `tsk.replaceBrokenReference` command. Two families of actions:
 *
 *   - **Add missing id + created** (M19/C): surfaces on any markered task
 *     line lacking `@id`. Edit precomputed via {@link promoteMissingMetadata}.
 *   - **Remove broken reference** / **Replace with picker…** (M20/C):
 *     surface when the cursor's line has a `broken-ref:<key>` diagnostic.
 *     "Remove" is a precomputed edit via `removeMetadataEntry`; "Replace"
 *     fires the internal command which opens the task picker and applies
 *     `setMetadataEntry(line, key, picked)` on resolve.
 *
 * **Why two backings (edit vs command).** Precomputed edits show a
 * preview and don't need the user to interact further. The replace flow
 * needs the picker — that's interactive, can only happen at click time,
 * so it lives behind a command.
 */
export function registerCodeActionsProvider(
    context: vscode.ExtensionContext,
    cache: CacheService,
    logger: Logger,
    deps: CodeActionDeps = defaultDeps,
): void {
    const provider: vscode.CodeActionProvider = {
        provideCodeActions(document, range, codeActionContext) {
            const lineNumber = range.start.line;
            const lineText = document.lineAt(lineNumber).text;
            const parsed = parseLine(lineText);
            if (!parsed) return undefined;

            const actions: vscode.CodeAction[] = [];

            // M19/C — promote missing id + created.
            if (!parsed.metadata.has('id')) {
                const next = promoteMissingMetadata(lineText, deps);
                if (next !== null) {
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
                    actions.push(action);
                }
            }

            // M20/C — broken-ref quick fixes. Per diagnostic on this line
            // whose code matches `broken-ref:<key>`, emit Remove + Replace.
            for (const diagnostic of codeActionContext.diagnostics) {
                const key = brokenRefKey(diagnostic);
                if (!key) continue;
                if (diagnostic.range.start.line !== lineNumber) continue;

                // Remove — precomputed edit.
                {
                    const removed = removeMetadataEntry(lineText, key);
                    if (removed !== lineText) {
                        const action = new vscode.CodeAction(
                            `Tsk: Remove broken @${key}`,
                            vscode.CodeActionKind.QuickFix,
                        );
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(
                            document.uri,
                            new vscode.Range(lineNumber, 0, lineNumber, lineText.length),
                            removed,
                        );
                        action.edit = edit;
                        action.diagnostics = [diagnostic];
                        actions.push(action);
                    }
                }

                // Replace — picker command, deferred to click.
                {
                    const action = new vscode.CodeAction(
                        `Tsk: Replace @${key} via picker…`,
                        vscode.CodeActionKind.QuickFix,
                    );
                    action.command = {
                        command: INTERNAL_COMMANDS.replaceBrokenReference,
                        title: action.title,
                        arguments: [document.uri, lineNumber, key],
                    };
                    action.diagnostics = [diagnostic];
                    actions.push(action);
                }
            }

            return actions.length > 0 ? actions : undefined;
        },
    };

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider({ language: TSK_LANGUAGE_ID }, provider, {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
        }),
        vscode.commands.registerCommand(
            INTERNAL_COMMANDS.replaceBrokenReference,
            async (uri: vscode.Uri, line: number, key: BrokenRefKey) => {
                const doc = await vscode.workspace.openTextDocument(uri);
                const lineText = doc.lineAt(line).text;
                if (parseLine(lineText) === null) {
                    logger.debug(
                        `${INTERNAL_COMMANDS.replaceBrokenReference}: line ${line + 1} no longer parses as a task`,
                    );
                    return;
                }
                const prompt = `Pick the replacement @${key} task`;
                const picked = await pickTaskId({ prompt, cache });
                if (!picked) {
                    logger.debug(`${INTERNAL_COMMANDS.replaceBrokenReference}: picker cancelled`);
                    return;
                }
                const next = setMetadataEntry(lineText, key, picked);
                if (next === lineText) return;
                const edit = new vscode.WorkspaceEdit();
                edit.replace(uri, new vscode.Range(line, 0, line, lineText.length), next);
                await vscode.workspace.applyEdit(edit);
            },
        ),
    );
}
