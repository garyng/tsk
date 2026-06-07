import * as vscode from 'vscode';
import { COMMANDS } from './constants';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import {
    buildMarkerSearchArgs,
    countTasksByMarker,
    markersToPickItems,
} from './lib/markers-find-logic';

/** Search Editor open command (verified present in VS Code ≥1.112). */
const SEARCH_EDITOR_COMMAND = 'search.action.openNewEditor';

/**
 * Register `tsk.findAllTasksByStatus` — the marker sibling of
 * `tsk.findAllTasksByTag` (M6):
 *
 *   1. QuickPick the status markers (glyph + per-marker task count).
 *   2. On pick → open VS Code's **Search Editor** with a line-anchored regex
 *      (`^\s*[-*+] \[<glyph>\]`) scoped to `*.tsk`, so every task carrying that
 *      marker is listed (and decorated by the M30/B search-result path — which
 *      is marker-agnostic, so no change there).
 *   3. On cancel → no-op.
 *
 * Palette-only (no keybinding): the find-by-tag command already takes a chord, and this secondary
 * search isn't worth a second global chord — users can bind it themselves. The
 * picker counts come from `cache.listAllTasks()` (markers are flat, so an
 * in-memory tally; no new query needed), mirroring how the tag picker counts.
 */
export function registerFindAllTasksByStatusCommand(
    context: vscode.ExtensionContext,
    cache: CacheService,
    logger: Logger,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.findAllTasksByStatus, async () => {
            const counts = countTasksByMarker(cache.listAllTasks());
            const items = markersToPickItems(counts);
            const picked = await vscode.window.showQuickPick(items, {
                title: 'Tsk: Find All Tasks by Status',
                placeHolder: 'Pick a status marker to find every task carrying it…',
                matchOnDescription: true,
            });
            if (!picked) return;
            const args = buildMarkerSearchArgs(picked.marker);
            logger.info(`${COMMANDS.findAllTasksByStatus}: searching for ${args.query}`);
            await vscode.commands.executeCommand(SEARCH_EDITOR_COMMAND, args);
        }),
    );
}
