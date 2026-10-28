import * as vscode from 'vscode';
import { COMMANDS } from './constants';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import { taskRefsIn } from './lib/tsk-ref';
import { selectInTuisBeside } from './terminal-tui';

/**
 * `tsk:<id>` in a terminal — Claude's output, `tsk trail`, a tmux pane — as a
 * link that reveals the task, and selects it in the TUI beside that terminal.
 * VS Code hands the provider the rendered line, so it works whatever printed
 * it. Only ids the workspace knows are links: terminal output is noisier than
 * a plan, and there's no marker to flag an unknown one.
 */
export class TaskTerminalLink extends vscode.TerminalLink {
    constructor(
        startIndex: number,
        length: number,
        tooltip: string,
        readonly id: string,
        /** The task's `.tsk` file. */
        readonly file: string,
        /** Where it was clicked. */
        readonly terminal: vscode.Terminal | undefined,
    ) {
        super(startIndex, length, tooltip);
    }
}

export function registerTerminalLinks(
    context: vscode.ExtensionContext,
    cache: CacheService,
    logger: Logger,
): vscode.TerminalLinkProvider<TaskTerminalLink> {
    const provider: vscode.TerminalLinkProvider<TaskTerminalLink> = {
        provideTerminalLinks: ({ line, terminal }) =>
            taskRefsIn(line).flatMap((ref) => {
                const task = cache.lookupById(ref.id);
                if (!task) return [];
                const file = vscode.Uri.parse(task.fileUri).fsPath;
                return [
                    new TaskTerminalLink(
                        ref.start,
                        ref.end - ref.start,
                        task.content,
                        ref.id,
                        file,
                        terminal,
                    ),
                ];
            }),
        handleTerminalLink: async (link) => {
            logger.info(`terminal link tsk:${link.id}`);
            await vscode.commands.executeCommand(COMMANDS.revealTask, link.id);
            await selectInTuisBeside(link.terminal, link.id, link.file, logger);
        },
    };
    context.subscriptions.push(vscode.window.registerTerminalLinkProvider(provider));
    return provider;
}
