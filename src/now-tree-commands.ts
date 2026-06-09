import * as vscode from 'vscode';
import { COMMANDS, INTERNAL_COMMANDS, NOW_AUTO_IN_PROGRESS_KEY } from './constants';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import type { NowStore } from './lib/now-store';
import { parseLine } from './lib/parser';
import { defaultToggleDeps, enterInprogress, type ToggleDeps } from './lib/toggle-mutators';
import { navigateTo, targetNotFoundMessage } from './navigation';
import type { NavigationHighlight } from './navigation-highlight';
import { type NowTarget, resolveNowTarget } from './now-resolve';
import { replaceLine } from './range-helpers';

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
    deps: ToggleDeps = defaultToggleDeps,
): void {
    /**
     * Reveal + highlight the task `@id`'s line in the SOURCE-side editor group —
     * the one the panel sits beside (the `sourceColumn` it passes) — reusing the
     * tab that's already showing the file, like markdown preview drives its
     * source. Never opens over the panel's own column (which is "active" right
     * after a webview click, and would spawn a stray new tab). Never edits.
     */
    /**
     * Navigate to a resolved task in the SOURCE editor group — reusing the tab
     * already showing the file (markdown-preview-source style); else the panel's
     * source column; else the first group — never a stray tab over the panel.
     */
    async function navigateToTarget(
        located: NowTarget,
        sourceColumn?: vscode.ViewColumn,
    ): Promise<void> {
        await navigateTo(
            { uri: located.uri, line: located.line },
            {
                highlight: navigationHighlight,
                reuseVisible: true,
                viewColumn: sourceColumn ?? vscode.ViewColumn.One,
                preview: false,
                preserveFocus: false,
            },
        );
    }

    async function jump(id: string, sourceColumn?: vscode.ViewColumn): Promise<void> {
        if (!id) return;
        const located = resolveNowTarget(cache, id);
        if (!located) {
            logger.warn(`${INTERNAL_COMMANDS.nowJump}: task @id "${id}" not found.`);
            void vscode.window.showInformationMessage(targetNotFoundMessage(id));
            return;
        }
        await navigateToTarget(located, sourceColumn);
    }

    /**
     * After a bump: NAVIGATE to the bumped task (open it in the source group,
     * like a jump) and — gated on `tsk.now.autoInProgress` — flip it into `[/]`
     * in-progress (the same `enterInprogress` transition mark-now applies).
     * Navigating first means the flip edits a VISIBLE editor (not a hidden
     * background edit) and lands you on the task you just said you're working on.
     * We re-verify the resolved line still carries that `@id` before editing, so a
     * stale cache location never flips the wrong line. Unresolved (untitled /
     * missing / unscanned) tasks navigate nowhere and are left untouched.
     */
    async function navigateAndFlip(id: string, sourceColumn?: vscode.ViewColumn): Promise<void> {
        const located = resolveNowTarget(cache, id);
        if (!located) return;
        await navigateToTarget(located, sourceColumn);
        if (!readAutoInProgress()) return;
        const doc = await vscode.workspace.openTextDocument(located.uri);
        if (located.line >= doc.lineCount) return;
        const before = doc.lineAt(located.line).text;
        if (parseLine(before)?.metadata.get('id') !== id) return; // stale location — don't touch
        const after = enterInprogress(before, deps);
        if (after === before) return; // already in-progress
        const edit = new vscode.WorkspaceEdit();
        replaceLine(edit, located.uri, located.line, before, after);
        if (!(await vscode.workspace.applyEdit(edit))) {
            logger.warn(`${INTERNAL_COMMANDS.nowBump}: [/] flip edit was rejected`);
        }
    }

    /** Switch the current "now" to the parent of the current node (undo one step). */
    function back(): void {
        const state = nowStore.getState();
        const current = state.currentEntryId;
        if (!current) return;
        const entry = state.entries.find((e) => e.entryId === current);
        if (entry?.parentId) nowStore.switchTo(entry.parentId);
    }

    /**
     * Wipe the whole now-history (tasks untouched). Confirms first via a
     * NON-modal notification toast (not a blocking modal popup): click "Clear"
     * to proceed, dismiss to cancel. Skips the toast when the tree is already
     * empty so a no-op clear never nags; NowStore.clear self-guards on empty too.
     */
    async function clear(): Promise<void> {
        const state = nowStore.getState();
        if (state.entries.length === 0 && state.currentEntryId === null) return;
        const choice = await vscode.window.showWarningMessage(
            'Clear the entire "now" history? Your tasks are not affected.',
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
        vscode.commands.registerCommand(
            INTERNAL_COMMANDS.nowBump,
            async (entryId: string, sourceColumn?: vscode.ViewColumn) => {
                if (!entryId) return;
                nowStore.bump(entryId);
                // Bump means "I'm working on this now" → jump to the task and flip
                // it to [/] like mark-now (gated on tsk.now.autoInProgress). Resolve
                // by @id off the bumped entry (it may live in a closed file).
                const id = nowStore.getState().entries.find((e) => e.entryId === entryId)?.id;
                if (id) await navigateAndFlip(id, sourceColumn);
            },
        ),
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

function readAutoInProgress(): boolean {
    // The contributed default (true); off only via an explicit user setting.
    return vscode.workspace.getConfiguration('tsk').get<boolean>(NOW_AUTO_IN_PROGRESS_KEY, true);
}
