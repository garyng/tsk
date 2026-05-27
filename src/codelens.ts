import * as vscode from 'vscode';
import { computeLensesForTask } from './lib/codelens-logic';
import type { GraphService } from './lib/graph-service';
import type { Logger } from './lib/logger';
import { parseDocument } from './lib/parser';

const TSK_LANGUAGE_ID = 'tsk';

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
                    new vscode.CodeLens(new vscode.Range(d.line, 0, d.line, 0), {
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
 * Register the `.tsk` CodeLensProvider plus the six navigation /
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
            void vscode.window.showInformationMessage(
                `Tsk: task @id "${targetId}" not found in the workspace.`,
            );
            return;
        }
        const uri = vscode.Uri.parse(node.fileUri);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        const targetRange = new vscode.Range(node.line, 0, node.line, 0);
        editor.selection = new vscode.Selection(targetRange.start, targetRange.end);
        editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    async function peek(
        sourceUri: string,
        sourceLine: number,
        ids: readonly string[],
    ): Promise<void> {
        const locations: vscode.Location[] = [];
        for (const id of ids) {
            const target = graph.getNode(id);
            if (!target) continue;
            locations.push(
                new vscode.Location(
                    vscode.Uri.parse(target.fileUri),
                    new vscode.Position(target.line, 0),
                ),
            );
        }
        if (locations.length === 0) {
            logger.warn(`peek: no resolvable targets among [${ids.join(', ')}].`);
            void vscode.window.showInformationMessage('Tsk: no target tasks found.');
            return;
        }
        await vscode.commands.executeCommand(
            'editor.action.peekLocations',
            vscode.Uri.parse(sourceUri),
            new vscode.Position(sourceLine, 0),
            locations,
            'peek',
        );
    }

    function missingTarget(targetId: string, label: string): void {
        void vscode.window.showInformationMessage(
            `Tsk: ${label} @id "${targetId}" doesn't exist in the workspace.`,
        );
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('tsk.goToParent', (id: string) => navigate(id)),
        vscode.commands.registerCommand('tsk.goToDependsOn', (id: string) => navigate(id)),
        vscode.commands.registerCommand('tsk.goToRelated', (id: string) => navigate(id)),
        vscode.commands.registerCommand(
            'tsk.findAllChildren',
            (sourceUri: string, sourceLine: number, ids: string[]) =>
                peek(sourceUri, sourceLine, ids),
        ),
        vscode.commands.registerCommand(
            'tsk.findAllDependents',
            (sourceUri: string, sourceLine: number, ids: string[]) =>
                peek(sourceUri, sourceLine, ids),
        ),
        vscode.commands.registerCommand(
            'tsk.findAllRelated',
            (sourceUri: string, sourceLine: number, ids: string[]) =>
                peek(sourceUri, sourceLine, ids),
        ),
        vscode.commands.registerCommand('tsk.codelens.missing', (targetId: string, label: string) =>
            missingTarget(targetId, label),
        ),
    );

    return {
        refresh: () => provider.refresh(),
    };
}
