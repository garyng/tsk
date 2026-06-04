import * as vscode from 'vscode';
import { COMMANDS, INTERNAL_COMMANDS } from './constants';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import type { NowStore } from './lib/now-store';
import { parseLine } from './lib/parser';
import type { NavigationHighlight } from './navigation-highlight';
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
    /** Reveal + highlight the task `@id`'s line (read-only peek — never edits). */
    async function jump(id: string): Promise<void> {
        if (!id) return;
        const located = locate(cache, id);
        if (!located) {
            logger.warn(`${INTERNAL_COMMANDS.nowJump}: task @id "${id}" not found.`);
            void vscode.window.showInformationMessage(
                `Tsk: task @id "${id}" not found in the workspace.`,
            );
            return;
        }
        const doc = await vscode.workspace.openTextDocument(located.uri);
        const editor = await vscode.window.showTextDocument(doc);
        const range = pointRange(located.line);
        editor.selection = new vscode.Selection(range.start, range.end);
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
        if (nowStore.getState().entries.length === 0) return; // safe no-op on empty
        const choice = await vscode.window.showWarningMessage(
            'Clear the entire "now" history? Your tasks are not affected.',
            { modal: true },
            'Clear',
        );
        if (choice === 'Clear') nowStore.clear();
    }

    context.subscriptions.push(
        vscode.commands.registerCommand(INTERNAL_COMMANDS.nowJump, (id: string) => jump(id)),
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

/**
 * Resolve a task `@id` to a `(uri, line)`. The cache covers saved + scanned
 * docs; on a miss, scan visible UNTITLED buffers (a just-marked task in an
 * unsaved doc isn't cached yet) so jump still lands.
 */
function locate(cache: CacheService, id: string): { uri: vscode.Uri; line: number } | undefined {
    const record = cache.lookupById(id);
    if (record) return { uri: vscode.Uri.parse(record.fileUri), line: record.line };

    for (const editor of vscode.window.visibleTextEditors) {
        const doc = editor.document;
        if (!doc.isUntitled) continue;
        for (let line = 0; line < doc.lineCount; line++) {
            if (parseLine(doc.lineAt(line).text)?.metadata.get('id') === id) {
                return { uri: doc.uri, line };
            }
        }
    }
    return undefined;
}
