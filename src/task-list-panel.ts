import * as vscode from 'vscode';
import { COMMANDS } from './constants';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import type { TaskListHostToWebview, TaskListWebviewToHost } from './lib/task-list-protocol';
import { buildTaskListView } from './lib/task-list-view-model';
import { navigateTo, targetNotFoundMessage } from './navigation';
import { buildWebviewHtml, webviewLocalResourceRoots } from './webview-html';

const VIEW_TYPE = 'tsk.taskList';

/**
 * Owns the "Tsk Task List" webview panel — an editor-area `WebviewPanel` (like
 * {@link StatsPanel}) listing every workspace task with status filter chips.
 * It posts a host-built {@link TaskListView} (every row, once) on `ready` and on
 * each cache rescan; the chip filter runs client-side. A row click posts `jump`,
 * which the host re-resolves by `@id` and reveals via {@link navigateTo}.
 *
 * Like {@link NowPanel}, it tracks the last active non-panel editor column so a
 * jump lands beside — never over — the panel.
 */
export class TaskListPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    /** Last viewmodel posted (serialized) — to skip re-posting an identical one. */
    private lastPosted: string | undefined;
    private readonly editorSub: vscode.Disposable;
    /** The editor group a jump navigates to — the last active non-panel editor. */
    private sourceColumn: vscode.ViewColumn = vscode.ViewColumn.One;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly cache: CacheService,
        private readonly logger: Logger,
    ) {
        this.sourceColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        this.editorSub = vscode.window.onDidChangeActiveTextEditor((editor) => {
            const col = editor?.viewColumn;
            if (col !== undefined && col !== this.panel?.viewColumn) this.sourceColumn = col;
        });
    }

    /** Open the panel, or reveal it if already open. */
    open(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active);
            return;
        }
        this.adopt(
            vscode.window.createWebviewPanel(
                VIEW_TYPE,
                'Tsk Task List',
                vscode.ViewColumn.Active,
                this.webviewOptions(),
            ),
        );
    }

    /** Re-attach to a panel restored by the serializer (e.g. after a reload). */
    revive(panel: vscode.WebviewPanel): void {
        this.adopt(panel);
    }

    /** Re-render from the current cache state. A no-op when the panel is closed. */
    refresh(): void {
        this.postRender();
    }

    dispose(): void {
        this.editorSub.dispose();
        this.panel?.dispose();
        this.panel = undefined;
    }

    // ── internals ───────────────────────────────────────────────────────────

    private adopt(panel: vscode.WebviewPanel): void {
        this.logger.debug(`${COMMANDS.openTaskList}: task-list webview panel attached`);
        this.panel = panel;
        this.lastPosted = undefined; // a fresh webview needs the next render unconditionally
        panel.webview.options = this.webviewOptions();
        panel.webview.html = buildWebviewHtml(
            panel.webview,
            this.extensionUri,
            'task-list.js',
            'Tsk Task List',
        );
        panel.webview.onDidReceiveMessage((message: TaskListWebviewToHost) => {
            if (message?.type === 'ready') this.postRender();
            else if (message?.type === 'jump') void this.jump(message.id);
        });
        panel.onDidDispose(() => {
            if (this.panel === panel) this.panel = undefined;
        });
    }

    private postRender(): void {
        if (!this.panel) return;
        const view = buildTaskListView(this.cache.listAllTasks());
        const serialized = JSON.stringify(view);
        if (serialized === this.lastPosted) return;
        this.lastPosted = serialized;
        const message: TaskListHostToWebview = { type: 'render', view };
        void this.panel.webview.postMessage(message);
    }

    private async jump(id: string): Promise<void> {
        const task = this.cache.lookupById(id);
        if (!task) {
            void vscode.window.showInformationMessage(targetNotFoundMessage(id));
            return;
        }
        await navigateTo(
            { uri: vscode.Uri.parse(task.fileUri), line: task.line },
            { viewColumn: this.sourceColumn, reuseVisible: true, preview: false },
        );
    }

    private webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
        return {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: webviewLocalResourceRoots(this.extensionUri),
        };
    }
}

/**
 * Construct the {@link TaskListPanel}, register the `tsk.openTaskList` command,
 * and register the serializer that revives a left-open / popped-out panel on
 * reload. Returns the panel so the caller can wire the rescan-tail refresh hook.
 */
export function registerTaskListPanel(
    context: vscode.ExtensionContext,
    cache: CacheService,
    logger: Logger,
): TaskListPanel {
    const panel = new TaskListPanel(context.extensionUri, cache, logger);
    context.subscriptions.push(
        panel,
        vscode.commands.registerCommand(COMMANDS.openTaskList, () => panel.open()),
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(revived: vscode.WebviewPanel) {
                panel.revive(revived);
            },
        }),
    );
    return panel;
}
