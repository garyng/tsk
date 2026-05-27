import * as vscode from 'vscode';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import { parseLine } from './lib/parser';
import { removeMetadataEntry, setMetadataEntry, swapMarker } from './lib/toggle';
import {
    defaultToggleDeps,
    type ToggleDeps,
    toggleCancelledMutator,
    toggleCompletedMutator,
    toggleInprogressMutator,
    toggleNoteMutator,
    toggleP1Mutator,
    toggleP2Mutator,
    toggleP3Mutator,
    toggleTodoMutator,
} from './lib/toggle-mutators';
import { pickTaskId } from './picker';

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
        ['tsk.toggleP1', bind(toggleP1Mutator)],
        ['tsk.toggleP2', bind(toggleP2Mutator)],
        ['tsk.toggleP3', bind(toggleP3Mutator)],
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

/**
 * Register `tsk.copyTaskId`. Reads the `@id` from the task on the primary
 * cursor's line and writes it to the clipboard. Surfaces a notification on
 * success / when the line isn't a task / when the task has no `@id` so the
 * keystroke is never silent.
 *
 * Distinct from {@link registerToggleCommands} because copying isn't a
 * line mutation — there's no `WorkspaceEdit` to assemble, no multi-cursor
 * dedup; the primary selection is the sole input.
 */
export function registerCopyTaskIdCommand(context: vscode.ExtensionContext, logger: Logger): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('tsk.copyTaskId', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                logger.debug('tsk.copyTaskId: no active editor');
                return;
            }
            if (editor.document.languageId !== TSK_LANGUAGE_ID) {
                logger.debug(
                    `tsk.copyTaskId: skipped — language id is "${editor.document.languageId}"`,
                );
                return;
            }
            const line = editor.document.lineAt(editor.selection.active.line).text;
            const parsed = parseLine(line);
            if (!parsed) {
                void vscode.window.showWarningMessage('Tsk: not on a task line.');
                return;
            }
            const id = parsed.metadata.get('id');
            if (typeof id !== 'string' || id === '') {
                void vscode.window.showWarningMessage('Tsk: this task has no @id.');
                return;
            }
            await vscode.env.clipboard.writeText(id);
            void vscode.window.showInformationMessage(`Tsk: copied "${id}" to clipboard.`);
        }),
    );
}

/**
 * Register the four picker-driven commands: `tsk.toggleMoved` plus the
 * three relationship toggles (`relatedTo` / `dependsOn` / `parent`).
 *
 * **Mode-decided-by-primary-cursor**: each command reads the primary
 * cursor's line state once at invocation:
 *   - **Relationship toggles** — if `@<key>` is absent on the primary
 *     cursor's task, open the picker → write the picked id to every task
 *     cursor's line (other cursors' existing values are overwritten — by
 *     design, lets multi-cursor users align several tasks in one keystroke).
 *     If `@<key>` is present on the primary, no picker; just remove the
 *     entry from every task cursor's line.
 *   - **`toggleMoved`** — if the primary task isn't `moved`, picker →
 *     swap marker + `@movedTo:<id>` + `@moved:<localTimestamp>` on every
 *     task cursor. If the primary IS already `moved`, swap back to `todo`
 *     and clear both metadata entries on every task cursor.
 *
 * The picker opens at most once per invocation. Cancellation (no id chosen)
 * bails before any edit; no partial state.
 */
export function registerRelationshipCommands(
    context: vscode.ExtensionContext,
    logger: Logger,
    cache: CacheService,
    deps: ToggleDeps = defaultToggleDeps,
): void {
    const registerRel = (commandId: string, key: string, prompt: string): void => {
        context.subscriptions.push(
            vscode.commands.registerCommand(commandId, async () => {
                await runRelationshipToggle(commandId, key, prompt, cache, logger);
            }),
        );
    };

    registerRel('tsk.toggleRelatedTo', 'relatedTo', 'Pick the related task');
    registerRel('tsk.toggleDependsOn', 'dependsOn', 'Pick the task this depends on');
    registerRel('tsk.toggleParent', 'parent', 'Pick the parent task');

    context.subscriptions.push(
        vscode.commands.registerCommand('tsk.toggleMoved', async () => {
            await runMovedToggle(cache, logger, deps);
        }),
    );
}

async function runRelationshipToggle(
    commandId: string,
    key: string,
    prompt: string,
    cache: CacheService,
    logger: Logger,
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        logger.debug(`${commandId}: no active editor`);
        return;
    }
    if (editor.document.languageId !== TSK_LANGUAGE_ID) {
        logger.debug(`${commandId}: skipped — language id is "${editor.document.languageId}"`);
        return;
    }

    const primaryLine = editor.document.lineAt(editor.selection.active.line).text;
    const primaryParsed = parseLine(primaryLine);
    if (!primaryParsed) {
        logger.debug(`${commandId}: primary cursor not on a task line`);
        return;
    }

    const isAdd = !primaryParsed.metadata.has(key);

    if (isAdd) {
        const id = await pickTaskId({ prompt, cache });
        if (!id) {
            logger.debug(`${commandId}: picker cancelled`);
            return;
        }
        await applyEdit(editor, (line) => setMetadataEntry(line, key, id), logger);
    } else {
        await applyEdit(editor, (line) => removeMetadataEntry(line, key), logger);
    }
}

async function runMovedToggle(
    cache: CacheService,
    logger: Logger,
    deps: ToggleDeps,
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        logger.debug('tsk.toggleMoved: no active editor');
        return;
    }
    if (editor.document.languageId !== TSK_LANGUAGE_ID) {
        logger.debug(`tsk.toggleMoved: skipped — language id is "${editor.document.languageId}"`);
        return;
    }

    const primaryLine = editor.document.lineAt(editor.selection.active.line).text;
    const primaryParsed = parseLine(primaryLine);
    if (!primaryParsed) {
        logger.debug('tsk.toggleMoved: primary cursor not on a task line');
        return;
    }

    if (primaryParsed.marker !== 'moved') {
        const id = await pickTaskId({ prompt: 'Pick the task this moved to', cache });
        if (!id) {
            logger.debug('tsk.toggleMoved: picker cancelled');
            return;
        }
        const ts = deps.now();
        await applyEdit(
            editor,
            (line) => {
                let next = swapMarker(line, 'moved');
                next = setMetadataEntry(next, 'movedTo', id);
                next = setMetadataEntry(next, 'moved', ts);
                return next;
            },
            logger,
        );
    } else {
        await applyEdit(
            editor,
            (line) => {
                let next = swapMarker(line, 'todo');
                next = removeMetadataEntry(next, 'movedTo');
                next = removeMetadataEntry(next, 'moved');
                return next;
            },
            logger,
        );
    }
}
