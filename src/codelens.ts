import * as vscode from 'vscode';
import { INTERNAL_COMMANDS, TSK_LANGUAGE_ID } from './constants';
import { computeLensesForTask } from './lib/codelens-logic';
import type { GraphService } from './lib/graph-service';
import type { Logger } from './lib/logger';
import { parseDocument } from './lib/parser';
import { type NavTarget, navigateTo, peekTargets, targetNotFoundMessage } from './navigation';
import type { NavigationHighlight } from './navigation-highlight';
import { pointRange } from './range-helpers';

class TskCodeLensProvider implements vscode.CodeLensProvider {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChange.event;

    constructor(private readonly graph: GraphService) {}

    /**
     * Tell VSCode to re-fetch lenses. Activation calls this whenever the
     * graph state changes — without it, lenses go stale on file edits
     * (VSCode caches `provideCodeLenses` output until this event fires).
     */
    refresh(): void {
        this._onDidChange.fire();
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (document.languageId !== TSK_LANGUAGE_ID) return [];
        const fileUri = document.uri.toString();
        const tasks = parseDocument(document.getText());
        const out: vscode.CodeLens[] = [];
        for (const task of tasks) {
            const descriptors = computeLensesForTask(
                { line: task.line, metadata: task.metadata },
                fileUri,
                (id) => this.graph.getNode(id),
            );
            for (const d of descriptors) {
                out.push(
                    new vscode.CodeLens(pointRange(d.line), {
                        title: d.title,
                        command: d.command,
                        arguments: d.args,
                    }),
                );
            }
        }
        return out;
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}

/**
 * Public handle returned from `registerCodelens` so activation can fire
 * a lens refresh after every graph state change without having to know
 * about the provider class internals.
 */
export interface CodelensHandle {
    refresh(): void;
}

/**
 * Register the `.tsk` CodeLensProvider plus the seven navigation /
 * peek commands it dispatches to, plus the dangling-edge "(missing)"
 * handler that pops an info toast.
 *
 * Commands are NOT contributed via `package.json contributes.commands`
 * — they're code-only invocations driven by lens clicks. Adding them
 * to the palette would surface no-arg invocations that can't do
 * anything useful (no target id), so we keep them out of the user's
 * way.
 */
export function registerCodelens(
    context: vscode.ExtensionContext,
    graph: GraphService,
    navigationHighlight: NavigationHighlight,
    logger: Logger,
): CodelensHandle {
    const provider = new TskCodeLensProvider(graph);
    context.subscriptions.push(
        provider,
        vscode.languages.registerCodeLensProvider({ language: TSK_LANGUAGE_ID }, provider),
    );

    async function navigate(targetId: string): Promise<void> {
        const node = graph.getNode(targetId);
        if (!node) {
            logger.warn(`navigate: task @id "${targetId}" not found.`);
            void vscode.window.showInformationMessage(targetNotFoundMessage(targetId));
            return;
        }
        await navigateTo(
            { uri: vscode.Uri.parse(node.fileUri), line: node.line },
            { highlight: navigationHighlight },
        );
    }

    async function peek(
        sourceUri: string,
        sourceLine: number,
        ids: readonly string[],
    ): Promise<void> {
        const targets: NavTarget[] = [];
        for (const id of ids) {
            const node = graph.getNode(id);
            if (node) targets.push({ uri: vscode.Uri.parse(node.fileUri), line: node.line });
        }
        const opened = await peekTargets(vscode.Uri.parse(sourceUri), sourceLine, targets);
        if (!opened) {
            logger.warn(`peek: no resolvable targets among [${ids.join(', ')}].`);
            void vscode.window.showInformationMessage('Tsk: no target tasks found.');
        }
    }

    function missingTarget(targetId: string, label: string): void {
        void vscode.window.showInformationMessage(
            `Tsk: ${label} @id "${targetId}" doesn't exist in the workspace.`,
        );
    }

    context.subscriptions.push(
        vscode.commands.registerCommand(INTERNAL_COMMANDS.goToParent, (id: string) => navigate(id)),
        vscode.commands.registerCommand(INTERNAL_COMMANDS.goToDependsOn, (id: string) =>
            navigate(id),
        ),
        vscode.commands.registerCommand(INTERNAL_COMMANDS.goToRelated, (id: string) =>
            navigate(id),
        ),
        vscode.commands.registerCommand(INTERNAL_COMMANDS.goToMovedTo, (id: string) =>
            navigate(id),
        ),
        vscode.commands.registerCommand(
            INTERNAL_COMMANDS.findAllChildren,
            (sourceUri: string, sourceLine: number, ids: string[]) =>
                peek(sourceUri, sourceLine, ids),
        ),
        vscode.commands.registerCommand(
            INTERNAL_COMMANDS.findAllDependents,
            (sourceUri: string, sourceLine: number, ids: string[]) =>
                peek(sourceUri, sourceLine, ids),
        ),
        vscode.commands.registerCommand(
            INTERNAL_COMMANDS.findAllRelated,
            (sourceUri: string, sourceLine: number, ids: string[]) =>
                peek(sourceUri, sourceLine, ids),
        ),
        vscode.commands.registerCommand(
            INTERNAL_COMMANDS.codelensMissing,
            (targetId: string, label: string) => missingTarget(targetId, label),
        ),
    );

    return {
        refresh: () => provider.refresh(),
    };
}
