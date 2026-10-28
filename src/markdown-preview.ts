import type MarkdownIt from 'markdown-it';
import * as vscode from 'vscode';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import { openTaskUri } from './lib/task-uri';
import { tskRefsPlugin } from './lib/tsk-ref-markdown-it';

/**
 * `tsk:<id>` in the Markdown preview (`markdown.markdownItPlugins`): VS Code's
 * Markdown extension hands `extendMarkdownIt` its markdown-it, in this
 * extension host, so the plugin reads the cache as the editor's links do. A
 * link is a `vscode://` URI for the URI handler: the preview passes those
 * through to VS Code, and doesn't enable `command:` links. After a rescan the
 * open previews are rendered again, so their markers follow the tasks.
 */
export interface MarkdownPreviewRefs {
    extendMarkdownIt(md: MarkdownIt): MarkdownIt;
    /** Render the open Markdown previews again; false when none is open. */
    refresh(): boolean;
}

const REFRESH_COMMAND = 'markdown.preview.refresh';

/** A Markdown preview tab: the preview panel, or the preview opened as an editor. */
const isPreview = (tab: vscode.Tab) =>
    (tab.input instanceof vscode.TabInputWebview &&
        tab.input.viewType.endsWith('markdown.preview')) ||
    (tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === 'vscode.markdown.preview.editor');

export function registerMarkdownPreviewRefs(
    context: vscode.ExtensionContext,
    cache: CacheService,
    logger: Logger,
): MarkdownPreviewRefs {
    return {
        extendMarkdownIt(md) {
            tskRefsPlugin(md, {
                task: (id) => {
                    const task = cache.lookupById(id);
                    return task && { marker: task.marker, text: task.content };
                },
                href: (id) => openTaskUri(vscode.env.uriScheme, context.extension.id, id),
            });
            logger.info('tsk:<id> links added to the Markdown preview.');
            return md;
        },
        refresh() {
            // Only with a preview open: the command would start the Markdown extension, language server and all.
            if (!vscode.window.tabGroups.all.some((g) => g.tabs.some(isPreview))) return false;
            vscode.commands.executeCommand(REFRESH_COMMAND).then(undefined, (err: unknown) => {
                logger.warn(`${REFRESH_COMMAND} failed: ${String(err)}`);
            });
            return true;
        },
    };
}
