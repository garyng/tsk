import * as vscode from 'vscode';
import { COMMANDS } from './constants';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import { mergeTagDefs } from './lib/tags-config';
import { buildFindInFilesArgs, tagsToPickItems } from './lib/tags-find-logic';
import type { TagsLoader } from './tags-loader';

/**
 * Register the `tsk.findAllTasksByTag` command. Behavior:
 *
 *   1. Merge current yaml + cache-discovered tags.
 *   2. Empty map → show an info message and exit.
 *   3. Otherwise open a QuickPick (matchOnDescription: true).
 *   4. On pick → fire `workbench.action.findInFiles` with `#<tag>` and
 *      a `*.tsk` include glob.
 *   5. On cancel → no-op.
 *
 * The findInFiles invocation uses VSCode's built-in Search Editor, so
 * users get Ctrl+Click navigation, multi-result preview, and the usual
 * regex / case / word-match toggles "for free" — we deliberately do
 * NOT build a custom result document.
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
            const items = tagsToPickItems(merged);
            const picked = await vscode.window.showQuickPick(items, {
                title: 'Tsk: Find All Tasks by Tag',
                placeHolder: 'Search tags by name or description…',
                matchOnDescription: true,
            });
            if (!picked) return;
            const args = buildFindInFilesArgs(picked.label);
            logger.info(`${COMMANDS.findAllTasksByTag}: searching for ${args.query}`);
            await vscode.commands.executeCommand('workbench.action.findInFiles', args);
        }),
    );
}
