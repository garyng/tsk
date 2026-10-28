import * as vscode from 'vscode';
import { COMMANDS } from './constants';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import { OPEN_TASK_PATH, taskIdFromInput, taskIdFromUri } from './lib/task-uri';
import { navigateTo, targetNotFoundMessage } from './navigation';
import type { NavigationHighlight } from './navigation-highlight';
import { resolveNowTarget } from './now-resolve';

/**
 * Open a task by its `@id`, from anywhere: `tsk.revealTask` (the palette asks
 * for the id; links pass it), and `vscode://garyng.tsk/open?id=<id>` for an
 * OSC 8 link, a browser or another app. Both land as the now-jump does — the
 * tab already showing the file, the line selected and highlighted.
 */
export interface RevealTask {
    /** True when the task was found and shown. */
    reveal(id: string): Promise<boolean>;
    handleUri(uri: vscode.Uri): Promise<void>;
}

export function registerRevealTask(
    context: vscode.ExtensionContext,
    cache: CacheService,
    navigationHighlight: NavigationHighlight,
    logger: Logger,
): RevealTask {
    async function reveal(id: string): Promise<boolean> {
        const target = resolveNowTarget(cache, id);
        if (!target) {
            logger.warn(`${COMMANDS.revealTask}: task @id "${id}" not found.`);
            void vscode.window.showInformationMessage(targetNotFoundMessage(id));
            return false;
        }
        logger.info(`${COMMANDS.revealTask}: ${id} → ${target.uri.fsPath}:${target.line + 1}.`);
        await navigateTo(target, {
            highlight: navigationHighlight,
            reuseVisible: true,
            preview: false,
        });
        return true;
    }

    async function askForId(): Promise<string | undefined> {
        const typed = await vscode.window.showInputBox({
            title: 'Reveal Task',
            prompt: 'tsk:<id> and @id:<id>',
            validateInput: (v) =>
                v.trim() === '' || taskIdFromInput(v)
                    ? undefined
                    : 'An id is one word: letters, digits, _ or -',
        });
        return typed === undefined ? undefined : taskIdFromInput(typed);
    }

    async function handleUri(uri: vscode.Uri): Promise<void> {
        logger.info(`URI ${uri.toString(true)}`);
        const id = taskIdFromUri(uri.path, uri.query);
        if (id) {
            await reveal(id);
            return;
        }
        const expected = `${vscode.env.uriScheme}://${context.extension.id}${OPEN_TASK_PATH}?id=<id>`;
        logger.warn(`URI not understood: ${uri.toString(true)} (expected ${expected}).`);
        void vscode.window.showWarningMessage(
            `Tsk: can't open ${uri.toString(true)} — expected ${expected}.`,
        );
    }

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.revealTask, async (arg?: unknown) => {
            const id = typeof arg === 'string' ? taskIdFromInput(arg) : await askForId();
            return id ? reveal(id) : false;
        }),
        vscode.window.registerUriHandler({ handleUri }),
    );
    return { reveal, handleUri };
}
