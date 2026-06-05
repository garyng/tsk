import * as vscode from 'vscode';
import { COMMANDS, INTERNAL_COMMANDS } from './constants';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import type { NowStore } from './lib/now-store';
import type { NavigationHighlight } from './navigation-highlight';
import { resolveNowTarget } from './now-resolve';
import { pointRange } from './range-helpers';

/**
 * Register the now-stack tree actions. All but `clear` are
 * {@link INTERNAL_COMMANDS} — the webview posts an action message, the panel
 * routes it here with the right argument (a task `@id` for `jump`, a tree
 * `entryId` for the mutators; `back`/`pruneOffPath` act on the current). They
 * stay out of the Command Palette because a no-arg palette invocation couldn't
 * supply a target. `clear` is the one user-facing entry point ("Tsk: Clear Now
 * History"), so it IS contributed.
 *
 * Every mutator is a thin delegate over the (already unit-tested, fully
 * id-tolerant) {@link NowStore} reducers, so a stale/garbage id is a safe no-op.
 */
export function registerNowTreeCommands(
    context: vscode.ExtensionContext,
    nowStore: NowStore,
    cache: CacheService,
    navigationHighlight: NavigationHighlight,
    logger: Logger,
): void {
    /**
     * Reveal + highlight the task `@id`'s line in the SOURCE-side editor group —
     * the one the panel sits beside (the `sourceColumn` it passes) — reusing the
     * tab that's already showing the file, like markdown preview drives its
     * source. Never opens over the panel's own column (which is "active" right
     * after a webview click, and would spawn a stray new tab). Never edits.
     */
    async function jump(id: string, sourceColumn?: vscode.ViewColumn): Promise<void> {
        if (!id) return;
        const located = resolveNowTarget(cache, id);
        if (!located) {
            logger.warn(`${INTERNAL_COMMANDS.nowJump}: task @id "${id}" not found.`);
            void vscode.window.showInformationMessage(
                `Tsk: task @id "${id}" not found in the workspace.`,
            );
            return;
        }
        const doc = await vscode.workspace.openTextDocument(located.uri);
        const range = pointRange(located.line);
        // Prefer the column already showing this doc (reuse that exact tab);
        // else the panel's source column; else the first group.
        const visible = vscode.window.visibleTextEditors.find(
            (e) => e.document.uri.toString() === doc.uri.toString(),
        );
        const viewColumn = visible?.viewColumn ?? sourceColumn ?? vscode.ViewColumn.One;
        const editor = await vscode.window.showTextDocument(doc, {
            viewColumn,
            preserveFocus: false,
            preview: false,
            selection: range,
        });
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        navigationHighlight.set(editor, located.line);
    }

    /** Switch the current "now" to the parent of the current node (undo one step). */
    function back(): void {
        const state = nowStore.getState();
        const current = state.currentEntryId;
        if (!current) return;
        const entry = state.entries.find((e) => e.entryId === current);
        if (entry?.parentId) nowStore.switchTo(entry.parentId);
    }

    /** Wipe the whole now-history (tasks untouched) — modal-confirmed, the only destructive one. */
    async function clear(): Promise<void> {
        // Match NowStore.clear's guard: skip the modal only when TRULY empty (no
        // entries AND no current), so a dangling pointer can still be reset.
        const state = nowStore.getState();
        if (state.entries.length === 0 && state.currentEntryId === null) return;
        const choice = await vscode.window.showWarningMessage(
            'Clear the entire "now" history? Your tasks are not affected.',
            { modal: true },
            'Clear',
        );
        if (choice === 'Clear') nowStore.clear();
    }

    context.subscriptions.push(
        vscode.commands.registerCommand(
            INTERNAL_COMMANDS.nowJump,
            (id: string, column?: vscode.ViewColumn) => jump(id, column),
        ),
        vscode.commands.registerCommand(INTERNAL_COMMANDS.nowSwitchTo, (entryId: string) => {
            if (entryId) nowStore.switchTo(entryId);
        }),
        vscode.commands.registerCommand(INTERNAL_COMMANDS.nowBack, () => back()),
        vscode.commands.registerCommand(INTERNAL_COMMANDS.nowRemove, (entryId: string) => {
            if (entryId) nowStore.removeEntry(entryId);
        }),
        vscode.commands.registerCommand(INTERNAL_COMMANDS.nowPruneSubtree, (entryId: string) => {
            if (entryId) nowStore.pruneSubtree(entryId);
        }),
        vscode.commands.registerCommand(INTERNAL_COMMANDS.nowPruneChildren, (entryId: string) => {
            if (entryId) nowStore.pruneChildren(entryId);
        }),
        vscode.commands.registerCommand(INTERNAL_COMMANDS.nowPruneOffPath, () =>
            nowStore.pruneOffPath(),
        ),
        vscode.commands.registerCommand(COMMANDS.nowClear, () => clear()),
    );
}
