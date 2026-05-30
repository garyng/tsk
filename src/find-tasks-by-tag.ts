import * as vscode from 'vscode';
import { COMMANDS } from './constants';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import { mergeTagDefs } from './lib/tags-config';
import { buildSearchEditorArgs, countTasksByTag, tagsToPickItems } from './lib/tags-find-logic';
import type { TagsLoader } from './tags-loader';

/** Search Editor open command (verified present in VS Code ≥1.112). */
const SEARCH_EDITOR_COMMAND = 'search.action.openNewEditor';

/**
 * Register the `tsk.findAllTasksByTag` command. Behavior:
 *
 *   1. Merge current yaml + cache-discovered tags.
 *   2. Empty map → show an info message and exit.
 *   3. Otherwise open a QuickPick (matchOnDescription: true) with
 *      per-tag task counts.
 *   4. On pick → open VS Code's **Search Editor** (`search.action.
 *      openNewEditor`) with `#<tag>` pre-queried + scoped to `*.tsk`.
 *   5. On cancel → no-op.
 *
 * The Search Editor (a full-tab result document, not the side panel) gives
 * users Ctrl+Click navigation and the usual regex / case toggles "for free" —
 * we deliberately do NOT build a custom result document. Its `search-result`
 * grammar doesn't highlight tsk rows (it only embeds built-in languages), so
 * the extension decorates the match rows itself (M30/B).
 */
export function registerFindAllTasksByTagCommand(
    context: vscode.ExtensionContext,
    cache: CacheService,
    loader: TagsLoader,
    logger: Logger,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.findAllTasksByTag, async () => {
            const merged = mergeTagDefs(loader.getTags(), cache.listAllTags());
            if (merged.size === 0) {
                void vscode.window.showInformationMessage(
                    'Tsk: no tags found in the current workspace.',
                );
                logger.info(`${COMMANDS.findAllTasksByTag}: aborted — no tags available.`);
                return;
            }
            const counts = countTasksByTag(cache.listAllTaskTags());
            const items = tagsToPickItems(merged, counts);
            const picked = await vscode.window.showQuickPick(items, {
                title: 'Tsk: Find All Tasks by Tag',
                placeHolder: 'Search tags by name, count, or description…',
                matchOnDescription: true,
            });
            if (!picked) return;
            const args = buildSearchEditorArgs(picked.label);
            logger.info(`${COMMANDS.findAllTasksByTag}: searching for ${args.query}`);
            await vscode.commands.executeCommand(SEARCH_EDITOR_COMMAND, args);
        }),
    );
}
