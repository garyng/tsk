import * as vscode from 'vscode';
import { INTERNAL_COMMANDS, TSK_LANGUAGE_ID } from './constants';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import { parseLine } from './lib/parser';
import { promoteMissingMetadata, removeMetadataEntry, setMetadataEntry } from './lib/toggle';
import { defaultToggleDeps, type ToggleDeps } from './lib/toggle-mutators';
import { pickTaskId } from './picker';
import { replaceLine } from './range-helpers';

type BrokenRefKey = 'parent' | 'dependsOn' | 'relatedTo' | 'movedTo';

function brokenRefKey(diagnostic: vscode.Diagnostic): BrokenRefKey | undefined {
    const code = diagnostic.code;
    if (typeof code !== 'string' || !code.startsWith('broken-ref:')) return undefined;
    const key = code.slice('broken-ref:'.length);
    if (key === 'parent' || key === 'dependsOn' || key === 'relatedTo' || key === 'movedTo') {
        return key;
    }
    return undefined;
}

/** The duplicated `@id` carried by an M7 `duplicate-id:<id>` diagnostic, else undefined. */
function duplicateIdValue(diagnostic: vscode.Diagnostic): string | undefined {
    const code = diagnostic.code;
    if (typeof code !== 'string' || !code.startsWith('duplicate-id:')) return undefined;
    return code.slice('duplicate-id:'.length);
}

/**
 * Register the QuickFix provider plus the internal
 * `tsk.replaceBrokenReference` command. Three families of actions:
 *
 *   - **Add missing id + created** (M19/C): surfaces on any markered task
 *     line lacking `@id`. Edit precomputed via {@link promoteMissingMetadata}.
 *   - **Remove broken reference** / **Replace with picker…** (M20/C):
 *     surface when the cursor's line has a `broken-ref:<key>` diagnostic.
 *     "Remove" is a precomputed edit via `removeMetadataEntry`; "Replace"
 *     fires the internal command which opens the task picker and applies
 *     `setMetadataEntry(line, key, picked)` on resolve.
 *   - **Regenerate @id** (M7): surfaces when the cursor's line has a
 *     `duplicate-id:<id>` diagnostic (the non-canonical occurrence of a
 *     collided id). Precomputed edit that stamps a fresh `@id` via
 *     `setMetadataEntry`; non-interactive, so no command needed. `@created`
 *     is left intact — the task isn't re-created, just disambiguated.
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
    deps: ToggleDeps = defaultToggleDeps,
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
                    replaceLine(edit, document.uri, lineNumber, lineText, next);
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
                        replaceLine(edit, document.uri, lineNumber, lineText, removed);
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

            // M7 — regenerate @id to resolve a duplicate. Per `duplicate-id:<id>`
            // diagnostic on this line, offer a precomputed fresh-@id edit.
            for (const diagnostic of codeActionContext.diagnostics) {
                const dupId = duplicateIdValue(diagnostic);
                if (dupId === undefined) continue;
                if (diagnostic.range.start.line !== lineNumber) continue;
                // Skip a stale diagnostic whose line no longer carries that id.
                if (parsed.metadata.get('id') !== dupId) continue;
                const next = setMetadataEntry(lineText, 'id', deps.generateId());
                if (next === lineText) continue;
                const action = new vscode.CodeAction(
                    'Tsk: Regenerate @id (resolve duplicate)',
                    vscode.CodeActionKind.QuickFix,
                );
                const edit = new vscode.WorkspaceEdit();
                replaceLine(edit, document.uri, lineNumber, lineText, next);
                action.edit = edit;
                action.diagnostics = [diagnostic];
                actions.push(action);
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
                replaceLine(edit, uri, line, lineText, next);
                await vscode.workspace.applyEdit(edit);
            },
        ),
    );
}
