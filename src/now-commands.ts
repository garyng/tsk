import * as vscode from 'vscode';
import { COMMANDS, NOW_AUTO_IN_PROGRESS_KEY } from './constants';
import { requireTskEditor } from './editor-guards';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import type { NowStore } from './lib/now-store';
import { parseLine } from './lib/parser';
import { promoteMissingMetadata } from './lib/toggle';
import { defaultToggleDeps, enterInprogress, type ToggleDeps } from './lib/toggle-mutators';
import { replaceLine } from './range-helpers';

/**
 * Register `tsk.markNow` (Alt+W) — mark the task on the primary cursor line as
 * the current "now", pushing it onto the persisted undo-tree.
 *
 * The single file write (one undo step): stamp `@id` (+`@created`) if missing,
 * and — when `tsk.now.autoInProgress` is on (default) — move the task into
 * `[/]`, stamping `@started`, via the SAME `enterInprogress` the Alt+S
 * in-progress toggle uses (no duplicated marker logic). Both are skipped when
 * unnecessary, so marking an already-`[/]`, already-id'd task touches no bytes.
 * The `@id` is then RE-READ from the document (never assumed —
 * `promoteMissingMetadata` returns only a new *line*, not the id) and handed to
 * the store; a `content` snapshot is kept only when the cache can't resolve the
 * id yet (untitled / not-yet-scanned), so the view has a label before the next
 * rescan.
 *
 * Operates on the PRIMARY cursor only — "now" is a single task, so a
 * multi-cursor mark wouldn't have a sensible meaning.
 *
 * `deps` is injected for deterministic tests, mirroring the toggle commands.
 */
export function registerNowCommands(
    context: vscode.ExtensionContext,
    nowStore: NowStore,
    cache: CacheService,
    logger: Logger,
    deps: ToggleDeps = defaultToggleDeps,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.markNow, async () => {
            const editor = requireTskEditor(logger, COMMANDS.markNow);
            if (!editor) return;

            const lineNo = editor.selection.active.line;
            const before = editor.document.lineAt(lineNo).text;
            if (!parseLine(before)) {
                void vscode.window.showInformationMessage('Tsk: not on a task line.');
                return;
            }

            let after = promoteMissingMetadata(before, deps) ?? before;
            if (readAutoInProgress()) after = enterInprogress(after, deps);
            if (after !== before) {
                const edit = new vscode.WorkspaceEdit();
                replaceLine(edit, editor.document.uri, lineNo, before, after);
                if (!(await vscode.workspace.applyEdit(edit))) {
                    logger.warn(`${COMMANDS.markNow}: workspace edit was rejected`);
                    void vscode.window.showWarningMessage('Tsk: could not update the task line.');
                    return;
                }
            }

            // Re-read the (possibly just-stamped) line — never assume the id.
            const parsed = parseLine(editor.document.lineAt(lineNo).text);
            const id = parsed?.metadata.get('id');
            if (typeof id !== 'string' || id === '') {
                logger.warn(`${COMMANDS.markNow}: task has no @id after the edit`);
                void vscode.window.showWarningMessage('Tsk: could not resolve the task @id.');
                return;
            }

            // Snapshot the content only when the cache can't resolve the id yet
            // (untitled, or not-yet-scanned) — otherwise the view reads it live.
            // `??` not `||`: an empty-content task (metadata only) has content === ''
            // and must still snapshot '' rather than collapse to "(missing)".
            const content = cache.lookupById(id) ? undefined : (parsed?.content ?? undefined);
            nowStore.markNow(id, content);
            logger.info(`${COMMANDS.markNow}: now = ${id}`);
        }),
    );
}

function readAutoInProgress(): boolean {
    // Throwaway `true` fallback — VSCode returns the package.json default (true)
    // for this contributed setting; off only via an explicit user setting.
    return vscode.workspace.getConfiguration('tsk').get<boolean>(NOW_AUTO_IN_PROGRESS_KEY, true);
}
