import * as vscode from 'vscode';
import { registerClipboardBridge } from './clipboard-bridge';
import { registerCodeActionsProvider } from './code-actions';
import { registerCodelens } from './codelens';
import {
    CACHE_PATH_KEY,
    COMMANDS,
    DIAGNOSTIC_SOURCE,
    EDITOR_CHANGE_DEBOUNCE_KEY,
    LOG_LEVEL_KEY,
    LOG_LEVEL_SETTING,
    OUTPUT_CHANNEL_NAME,
    PRIORITY_OPACITY_KEY,
    PRIORITY_OPACITY_SETTING,
} from './constants';
import { type DecorationSnapshot, DecorationsController } from './decorations-controller';
import { DiagnosticsManager } from './diagnostics-manager';
import { registerDuplicateCommands } from './duplicate-commands';
import { isPersistableDocument, isTskDocument } from './editor-guards';
import { registerFindAllTasksByTagCommand } from './find-tasks-by-tag';
import { registerHoverProvider } from './hover';
import { registerInstallClipboardBridgeSkillCommand } from './install-clipboard-bridge-skill';
import { CacheService } from './lib/cache';
import { ensureCacheParentDir, IN_MEMORY, resolveCachePath } from './lib/cache-path';
import { type CacheCounts, Db, type TaskRecord } from './lib/db';
import type { GraphNode } from './lib/graph';
import { GraphService } from './lib/graph-service';
import { Logger, type LogLevel } from './lib/logger';
import { clampPriorityOpacity, parseChangeDebounceMs, parseLogLevel } from './lib/settings';
import type { TagDef } from './lib/tags-config';
import { registerListEditCommands } from './list-edit-commands';
import { NavigationHighlight } from './navigation-highlight';
import { registerPasteImageProvider } from './paste-image';
import { ScanController } from './scan-controller';
import { registerSemanticTokens } from './semantic-tokens';
import { registerTagsCompletionProvider } from './tags-completion';
import { createTagsLoader, type TagsLoader } from './tags-loader';
import {
    registerCopyTaskIdCommand,
    registerRelationshipCommands,
    registerToggleCommands,
} from './toggle-commands';

/**
 * Stable surface returned from `activate()`. End-to-end tests acquire this
 * via `extensions.getExtension('garyng.tsk').activate()` to introspect the
 * cache without driving commands through VSCode UI.
 *
 * Keep this minimal — every export is a public contract that test suites
 * and downstream tools may rely on.
 */
export interface TskExtensionApi {
    counts(): CacheCounts;
    findTaskById(id: string): TaskRecord | undefined;
    listAllTags(): string[];
    /**
     * Last-applied decoration ranges for `uri.toString()`. Returns `undefined`
     * if the URI has never been decorated (no editor opened yet, or it's not
     * a `.tsk` file). Maps are flattened to plain Records so e2e tests can
     * make stable `deepStrictEqual` assertions.
     */
    getDecorations(uri: string): DecorationSnapshot | undefined;
    /**
     * Current snapshot of the parsed `tags.yml` state. Empty when no
     * workspace is open or the file is missing.
     */
    getTags(): ReadonlyMap<string, TagDef>;
    /**
     * Re-read `tags.yml` and replace the in-memory state. Exposed for
     * deterministic e2e testing (config change → reload → assert), but
     * safe to call at any time.
     */
    reloadTags(): Promise<void>;
    /**
     * Look up a graph node by `@id`. Returns `undefined` when no canonical
     * occurrence exists. M9/B introduces this so e2e tests can assert
     * forward / inverse edge state without driving the codelens UI.
     */
    lookupGraph(id: string): GraphNode | undefined;
    /**
     * Snapshot of the active navigation highlight (M10/A). `undefined`
     * when no highlight is rendered. Exposed for e2e introspection
     * since VSCode doesn't expose decoration state directly.
     */
    getNavigationHighlight(): { uri: string; line: number } | undefined;
}

/**
 * Per the **Warnings convention**: every `CacheWarning` surfaces both as a
 * log line in the `tsk` Output channel AND as a `vscode.Diagnostic` squiggle
 * on the offending range, managed through a single `DiagnosticCollection`.
 *
 * Activation is async because the initial workspace scan needs to complete
 * before features that depend on the cache become useful. Subsequent file
 * events (save / change / fs watcher) trigger per-file rescans that update
 * both the cache and the diagnostic collection atomically.
 */

let state: ActivationState | undefined;

interface ActivationState {
    logger: Logger;
    /** Decoration engine — owns the decoration types, debounce timers, snapshots. */
    decorations: DecorationsController;
    /** Scan engine — owns the cache-rescan orchestration + change-debounce timers. */
    scan: ScanController;
}

export async function activate(context: vscode.ExtensionContext): Promise<TskExtensionApi> {
    const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    context.subscriptions.push(channel);

    const logger = new Logger(channel, readLogLevel());
    logger.info('tsk extension activating.');

    const { cache } = openCache(context, logger);
    const decorations = new DecorationsController(context, readPriorityOpacity());

    const diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
    context.subscriptions.push(diagnostics);

    const graph = new GraphService();
    const diagnosticsManager = new DiagnosticsManager(diagnostics);
    const navigationHighlight = new NavigationHighlight();
    context.subscriptions.push(navigationHighlight);
    const codelens = registerCodelens(context, graph, navigationHighlight, logger);
    const scan = new ScanController(cache, graph, diagnosticsManager, codelens, logger);

    state = {
        logger,
        decorations,
        scan,
    };

    attachConfigListener(context, logger);

    await scan.runInitialScan();
    // workspaceContains activation can fire with `.tsk` editors already visible
    // (e.g. when restoring a previous session). Decorate them right after the
    // initial scan finishes.
    for (const editor of vscode.window.visibleTextEditors) {
        decorations.applyToEditor(editor);
    }

    attachFileSystemWatcher(context);
    attachDocumentListeners(context);

    const tagsLoader = await createTagsLoader(context, logger);
    registerAllCommands(context, cache, graph, tagsLoader, logger);

    registerClipboardBridge(context, logger);
    registerInstallClipboardBridgeSkillCommand(context, logger);
    registerPasteImageProvider(context, logger);
    registerSemanticTokens(context);

    logger.info('tsk extension activated.');

    return {
        counts: () => cache.counts(),
        findTaskById: (id) => cache.lookupById(id),
        listAllTags: () => cache.listAllTags(),
        getDecorations: (uri) => state?.decorations.getSnapshot(uri),
        getTags: () => tagsLoader.getTags(),
        reloadTags: () => tagsLoader.reload(),
        lookupGraph: (id) => graph.getNode(id),
        getNavigationHighlight: () => navigationHighlight.getCurrent(),
    };
}

export function deactivate(): void {
    state?.logger.info('tsk extension deactivated.');
    if (state) {
        state.scan.clearTimers();
        state.decorations.clearTimers();
    }
    state = undefined;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve the configured cache path, open the SQLite cache, and register
 * the close hook on `context.subscriptions`. Logs the resolved path (or
 * `IN_MEMORY` fallback) to the Output channel.
 */
function openCache(
    context: vscode.ExtensionContext,
    logger: Logger,
): { db: Db; cache: CacheService } {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const rawSetting = vscode.workspace.getConfiguration('tsk').get<string>(CACHE_PATH_KEY, '');
    const cachePath = resolveCachePath(rawSetting, workspaceFolder);
    ensureCacheParentDir(cachePath);

    const db = new Db(cachePath);
    const cache = new CacheService(db);
    context.subscriptions.push({ dispose: () => db.close() });

    if (cachePath === IN_MEMORY) {
        logger.info('cache opened in-memory (no workspace folder).');
    } else {
        logger.info(`cache opened at ${cachePath}.`);
    }

    return { db, cache };
}

/**
 * Wire the `onDidChangeConfiguration` listener. Reacts to two settings:
 * the log level (re-reads the level + announces the change) and the
 * priority opacity (rebuilds the decoration types + announces).
 */
function attachConfigListener(context: vscode.ExtensionContext, logger: Logger): void {
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(LOG_LEVEL_SETTING)) {
                logger.setLevel(readLogLevel());
                logger.info(`log level changed to ${readLogLevel()}.`);
            }
            if (event.affectsConfiguration(PRIORITY_OPACITY_SETTING)) {
                state?.decorations.rebuildPriority(readPriorityOpacity());
                logger.info(`priority opacity changed to ${readPriorityOpacity()}.`);
            }
        }),
    );
}

/**
 * Wire the workspace `**\/*.tsk` FileSystemWatcher. Create / change events
 * delegate to the scan controller's `rescanFromFs`; delete clears the URI's
 * cache / graph / diagnostics via `scan.removeFile` and its decoration
 * snapshot via `decorations.evict`.
 */
function attachFileSystemWatcher(context: vscode.ExtensionContext): void {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.tsk');
    context.subscriptions.push(
        watcher,
        watcher.onDidCreate((uri) => void state?.scan.rescanFromFs(uri)),
        watcher.onDidChange((uri) => void state?.scan.rescanFromFs(uri)),
        watcher.onDidDelete((uri) => {
            if (!state) return;
            const key = uri.toString();
            state.scan.removeFile(key);
            state.decorations.evict(key);
        }),
    );
}

/**
 * Wire the four document / editor lifecycle listeners. Save triggers a
 * synchronous rescan; change triggers a debounced rescan + decorate.
 * Editor visibility events (active / visible-list changed) trigger
 * decoration only — the cache state is unaffected by which editor is
 * focused.
 *
 * Persistable vs non-persistable: cache writes are gated by
 * `isPersistableDocument` (false for untitled buffers). Untitled docs
 * still drive decoration / completion live, but their tasks
 * never reach SQLite — see M18 for the local-only scope.
 */
function attachDocumentListeners(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (!isTskDocument(doc)) return;
            if (isPersistableDocument(doc)) state?.scan.rescanFromDoc(doc);
            state?.decorations.applyForDoc(doc);
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            const doc = event.document;
            if (isTskDocument(doc)) {
                if (isPersistableDocument(doc))
                    state?.scan.scheduleRescan(doc, readChangeDebounceMs());
                state?.decorations.scheduleDecorate(doc, readChangeDebounceMs());
            } else if (doc.languageId === 'search-result') {
                // Search Editor results populate (and re-populate on re-search)
                // via document edits — re-decorate the match rows when they do.
                state?.decorations.scheduleDecorate(doc, readChangeDebounceMs());
            }
        }),
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) state?.decorations.applyToEditor(editor);
        }),
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            for (const editor of editors) state?.decorations.applyToEditor(editor);
        }),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            // Evict the decoration snapshot for a closed buffer so the Map
            // doesn't grow unbounded across untitled docs (Untitled-1, …),
            // which never reach the on-disk delete watcher. (M31/A — the leak
            // flagged in M18.) Also clear any pending decorate timer for it.
            state?.decorations.evict(doc.uri.toString());
        }),
    );
}

/**
 * Register every contributed command: the toggle set, the copy-id
 * command, the relationship picker commands, the list-edit handlers,
 * the tags completion provider, the find-by-tag command, and the
 * `tsk.rebuildCache` palette entry. Commands registered via the
 * codelens provider are attached separately during initial setup.
 */
function registerAllCommands(
    context: vscode.ExtensionContext,
    cache: CacheService,
    graph: GraphService,
    tagsLoader: TagsLoader,
    logger: Logger,
): void {
    registerToggleCommands(context, logger);
    registerCopyTaskIdCommand(context, logger);
    registerRelationshipCommands(context, logger, cache);
    registerListEditCommands(context, logger);
    registerDuplicateCommands(context, logger);
    registerTagsCompletionProvider(context, cache, tagsLoader);
    registerFindAllTasksByTagCommand(context, cache, tagsLoader, logger);
    registerCodeActionsProvider(context, cache, logger);
    registerHoverProvider(context, cache, graph, tagsLoader);

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.rebuildCache, async () => {
            if (!state) return;
            state.logger.info(`${COMMANDS.rebuildCache} invoked.`);
            await state.scan.rebuild();
            void vscode.window.showInformationMessage('Tsk: cache rebuilt.');
        }),
    );
}

function readLogLevel(): LogLevel {
    // Throwaway '' fallback — VSCode returns the package.json default ('info')
    // for this contributed setting; the parser recovers anything malformed
    // (only reachable via a hand-edited settings.json) to the safe level.
    const value = vscode.workspace.getConfiguration('tsk').get<string>(LOG_LEVEL_KEY, '');
    return parseLogLevel(value);
}

function readChangeDebounceMs(): number {
    // Throwaway 0 fallback — VSCode returns the package.json default (300) for
    // this contributed setting; the parser clamps a hand-edited value.
    const value = vscode.workspace
        .getConfiguration('tsk')
        .get<number>(EDITOR_CHANGE_DEBOUNCE_KEY, 0);
    return parseChangeDebounceMs(value);
}

function readPriorityOpacity(): number {
    // Throwaway 0 fallback — VSCode returns the package.json default (0.15)
    // for this contributed setting; the parser clamps a hand-edited value to
    // [0, 1] (the schema enforces it in the UI but settings.json can smuggle).
    const value = vscode.workspace.getConfiguration('tsk').get<number>(PRIORITY_OPACITY_KEY, 0);
    return clampPriorityOpacity(value);
}
