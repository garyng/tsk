import * as vscode from 'vscode';
import { COMMANDS } from './constants';
import { isTskDocument } from './editor-guards';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import type { TaskListHostToWebview, TaskListWebviewToHost } from './lib/task-list-protocol';
import { type ActiveFile, buildTaskListView, pickActiveFile } from './lib/task-list-view-model';
import { navigateTo, targetNotFoundMessage } from './navigation';
import { buildWebviewHtml, webviewLocalResourceRoots } from './webview-html';

/** The active editor as a `pickActiveFile` candidate (its URI + whether it's a `.tsk` doc). */
function activeFileCandidate(
    editor: vscode.TextEditor | undefined,
): { uri: string; isTsk: boolean } | undefined {
    if (!editor) return undefined;
    return { uri: editor.document.uri.toString(), isTsk: isTskDocument(editor.document) };
}

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
    /** A day-filter awaiting the webview handshake (set when opening from the stats jump). */
    private pendingDayFilter: { ids: string[]; label: string } | undefined;
    private readonly editorSub: vscode.Disposable;
    /** The editor group a jump navigates to — the last active non-panel editor. */
    private sourceColumn: vscode.ViewColumn = vscode.ViewColumn.One;
    /** The last active `.tsk` file (for the webview's "Current file" filter); `undefined` until one is active. */
    private activeFile: ActiveFile | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly cache: CacheService,
        private readonly logger: Logger,
    ) {
        this.sourceColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        this.activeFile = pickActiveFile(
            undefined,
            activeFileCandidate(vscode.window.activeTextEditor),
        );
        this.editorSub = vscode.window.onDidChangeActiveTextEditor((editor) => {
            const col = editor?.viewColumn;
            if (col !== undefined && col !== this.panel?.viewColumn) this.sourceColumn = col;
            // Track the last active .tsk file and tell the webview when it changes,
            // so the "Current file" filter follows editor switches (last-tsk-wins —
            // focusing the panel or a non-tsk file keeps the prior target).
            const next = pickActiveFile(this.activeFile, activeFileCandidate(editor));
            if (next?.uri !== this.activeFile?.uri) {
                this.activeFile = next;
                this.postActiveFile();
            }
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

    /**
     * Open (or reveal) the panel filtered to a set of task ids, e.g. from a stats
     * calendar-day click. If the panel is fresh, the directive waits for the
     * webview's `ready`; if it's already up, it posts immediately.
     */
    openWithDayFilter(ids: string[], label: string): void {
        this.pendingDayFilter = { ids, label };
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active);
            this.postDayFilter();
        } else {
            this.open();
        }
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
            if (message?.type === 'ready') {
                this.postRender();
                this.postDayFilter();
                this.postActiveFile();
            } else if (message?.type === 'jump') void this.jump(message.id);
        });
        panel.onDidDispose(() => {
            if (this.panel === panel) this.panel = undefined;
        });
    }

    private postRender(): void {
        if (!this.panel) return;
        const view = buildTaskListView(
            this.cache.listAllTasks(),
            this.cache.listAllTaskTags(),
            this.cache.listAllMetadata(),
        );
        const serialized = JSON.stringify(view);
        if (serialized === this.lastPosted) return;
        this.lastPosted = serialized;
        const message: TaskListHostToWebview = { type: 'render', view };
        void this.panel.webview.postMessage(message);
    }

    /** Tell the webview which `.tsk` file is active, so its "Current file" filter can target it. */
    private postActiveFile(): void {
        if (!this.panel || !this.activeFile) return;
        const message: TaskListHostToWebview = {
            type: 'activeFile',
            uri: this.activeFile.uri,
            name: this.activeFile.name,
        };
        void this.panel.webview.postMessage(message);
    }

    /** Flush a queued day-filter directive to the webview (once it's mounted). */
    private postDayFilter(): void {
        if (!this.panel || !this.pendingDayFilter) return;
        const { ids, label } = this.pendingDayFilter;
        this.pendingDayFilter = undefined;
        const message: TaskListHostToWebview = { type: 'dayFilter', ids, label };
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
