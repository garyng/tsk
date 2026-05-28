import * as vscode from 'vscode';
import { registerCodeActionsProvider } from './code-actions';
import { type CodelensHandle, registerCodelens } from './codelens';
import {
    CACHE_PATH_KEY,
    COMMANDS,
    DEFAULT_LOG_LEVEL,
    DEFAULT_PRIORITY_OPACITY,
    DIAGNOSTIC_SOURCE,
    DOC_CHANGE_DEBOUNCE_MS,
    LOG_LEVEL_KEY,
    LOG_LEVEL_SETTING,
    METADATA_FOREGROUND_COLOR_ID,
    OUTPUT_CHANNEL_NAME,
    PRIORITY_OPACITY_KEY,
    PRIORITY_OPACITY_SETTING,
} from './constants';
import { DiagnosticsManager } from './diagnostics-manager';
import { isPersistableDocument, isTskDocument } from './editor-guards';
import { registerFindAllTasksByTagCommand } from './find-tasks-by-tag';
import { registerHoverProvider } from './hover';
import { CacheService, type CacheWarning } from './lib/cache';
import { ensureCacheParentDir, IN_MEMORY, resolveCachePath } from './lib/cache-path';
import { type CacheCounts, Db, type TaskRecord } from './lib/db';
import { scheduleDebounced } from './lib/debounce';
import {
    computeMarkerRanges,
    computeMetadataRanges,
    computePriorityRanges,
    priorityBackgroundColor,
    type RangeLike,
} from './lib/decorations';
import type { GraphNode } from './lib/graph';
import { GraphService } from './lib/graph-service';
import { Logger, type LogLevel } from './lib/logger';
import { MARKERS, type Marker } from './lib/markers';
import { parseDocument } from './lib/parser';
import { PRIORITIES, type PriorityLevel } from './lib/priorities';
import type { TagDef } from './lib/tags-config';
import { registerListEditCommands } from './list-edit-commands';
import { NavigationHighlight } from './navigation-highlight';
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

export interface DecorationSnapshot {
    markers: Record<Marker, RangeLike[]>;
    priorities: Record<PriorityLevel, RangeLike[]>;
    /** Flat list of `<!-- ... -->` ranges across all tasks on this URI. */
    metadata: RangeLike[];
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
    db: Db;
    cache: CacheService;
    graph: GraphService;
    codelens: CodelensHandle;
    logger: Logger;
    diagnostics: vscode.DiagnosticCollection;
    diagnosticsManager: DiagnosticsManager;
    /** Per-URI debounce timers for cache rescan on doc change. */
    changeTimers: Map<string, NodeJS.Timeout>;
    /**
     * Per-URI debounce timers for decoration refresh on doc change. Kept
     * separate from `changeTimers` so decoration latency stays decoupled
     * from cache rescan latency.
     */
    decorationTimers: Map<string, NodeJS.Timeout>;
    /** Per-marker decoration types — built once, live for the activation. */
    markerDecorationTypes: Record<Marker, vscode.TextEditorDecorationType>;
    /** Per-priority decoration types — rebuilt when opacity setting changes. */
    priorityDecorationTypes: Record<PriorityLevel, vscode.TextEditorDecorationType>;
    /**
     * Single dimmed decoration type for inline metadata comments. Color is
     * `tsk.metadata.foreground` (themable), built once.
     */
    metadataDecorationType: vscode.TextEditorDecorationType;
    /** Per-URI snapshot of last-applied decoration ranges (for the e2e API). */
    decorationSnapshots: Map<string, DecorationSnapshot>;
}

export async function activate(context: vscode.ExtensionContext): Promise<TskExtensionApi> {
    const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    context.subscriptions.push(channel);

    const logger = new Logger(channel, readLogLevel());
    logger.info('tsk extension activating.');

    const { db, cache } = openCache(context, logger);
    const decorationTypes = buildAllDecorationTypes(context);

    const diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
    context.subscriptions.push(diagnostics);

    const graph = new GraphService();
    const diagnosticsManager = new DiagnosticsManager(diagnostics);
    const navigationHighlight = new NavigationHighlight();
    context.subscriptions.push(navigationHighlight);
    const codelens = registerCodelens(context, graph, navigationHighlight, logger);

    state = {
        db,
        cache,
        graph,
        codelens,
        logger,
        diagnostics,
        diagnosticsManager,
        changeTimers: new Map(),
        decorationTimers: new Map(),
        ...decorationTypes,
        decorationSnapshots: new Map(),
    };

    attachConfigListener(context, logger);

    await runInitialScan();
    // workspaceContains activation can fire with `.tsk` editors already visible
    // (e.g. when restoring a previous session). Decorate them right after the
    // initial scan finishes.
    for (const editor of vscode.window.visibleTextEditors) {
        applyDecorationsToEditor(editor);
    }

    attachFileSystemWatcher(context);
    attachDocumentListeners(context);

    const tagsLoader = await createTagsLoader(context, logger);
    registerAllCommands(context, cache, graph, tagsLoader, logger);

    logger.info('tsk extension activated.');

    return {
        counts: () => cache.counts(),
        findTaskById: (id) => cache.lookupById(id),
        listAllTags: () => cache.listAllTags(),
        getDecorations: (uri) => state?.decorationSnapshots.get(uri),
        getTags: () => tagsLoader.getTags(),
        reloadTags: () => tagsLoader.reload(),
        lookupGraph: (id) => graph.getNode(id),
        getNavigationHighlight: () => navigationHighlight.getCurrent(),
    };
}

export function deactivate(): void {
    state?.logger.info('tsk extension deactivated.');
    if (state) {
        for (const timer of state.changeTimers.values()) clearTimeout(timer);
        state.changeTimers.clear();
        for (const timer of state.decorationTimers.values()) clearTimeout(timer);
        state.decorationTimers.clear();
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
 * Build the three decoration-type collections (markers, priorities,
 * metadata) and register their disposers. Priority decorations are
 * rebuilt on opacity changes — the disposer walks the *current* set
 * held in state, so the post-activation replacement still cleans up.
 */
function buildAllDecorationTypes(context: vscode.ExtensionContext): {
    markerDecorationTypes: Record<Marker, vscode.TextEditorDecorationType>;
    priorityDecorationTypes: Record<PriorityLevel, vscode.TextEditorDecorationType>;
    metadataDecorationType: vscode.TextEditorDecorationType;
} {
    const markerDecorationTypes = buildMarkerDecorationTypes();
    for (const type of Object.values(markerDecorationTypes)) context.subscriptions.push(type);

    const priorityDecorationTypes = buildPriorityDecorationTypes(readPriorityOpacity());
    context.subscriptions.push({
        dispose: () => {
            if (!state) return;
            for (const type of Object.values(state.priorityDecorationTypes)) type.dispose();
        },
    });

    const metadataDecorationType = vscode.window.createTextEditorDecorationType({
        color: new vscode.ThemeColor(METADATA_FOREGROUND_COLOR_ID),
    });
    context.subscriptions.push(metadataDecorationType);

    return { markerDecorationTypes, priorityDecorationTypes, metadataDecorationType };
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
                rebuildPriorityDecorationTypes();
                logger.info(`priority opacity changed to ${readPriorityOpacity()}.`);
            }
        }),
    );
}

/**
 * Wire the workspace `**\/*.tsk` FileSystemWatcher. Create / change
 * events delegate to {@link rescanFromFs}; delete events clear the
 * URI's cache / graph / diagnostics / decoration state in one shot.
 */
function attachFileSystemWatcher(context: vscode.ExtensionContext): void {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.tsk');
    context.subscriptions.push(
        watcher,
        watcher.onDidCreate((uri) => void rescanFromFs(uri)),
        watcher.onDidChange((uri) => void rescanFromFs(uri)),
        watcher.onDidDelete((uri) => {
            if (!state) return;
            const key = uri.toString();
            state.cache.removeFile(key);
            state.graph.removeFile(key);
            state.diagnosticsManager.deleteFile(key);
            state.diagnosticsManager.setGraphDuplicates(state.graph.getDuplicates());
            state.diagnosticsManager.setBrokenReferences(state.graph.getBrokenForwardEdges());
            state.codelens.refresh();
            state.decorationSnapshots.delete(key);
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
 * still drive decoration / codelens / completion live, but their tasks
 * never reach SQLite — see M18 for the local-only scope.
 */
function attachDocumentListeners(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (!isTskDocument(doc)) return;
            if (isPersistableDocument(doc)) rescanFromDoc(doc);
            applyDecorationsForDoc(doc);
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (!isTskDocument(event.document)) return;
            if (isPersistableDocument(event.document)) scheduleDebouncedRescan(event.document);
            scheduleDebouncedDecorate(event.document);
        }),
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) applyDecorationsToEditor(editor);
        }),
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            for (const editor of editors) applyDecorationsToEditor(editor);
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
    registerTagsCompletionProvider(context, cache, tagsLoader);
    registerFindAllTasksByTagCommand(context, cache, tagsLoader, logger);
    registerCodeActionsProvider(context, cache, logger);
    registerHoverProvider(context, cache, graph, tagsLoader);

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.rebuildCache, async () => {
            if (!state) return;
            state.logger.info(`${COMMANDS.rebuildCache} invoked.`);
            state.diagnosticsManager.clear();
            state.cache.purge();
            state.graph.purge();
            await runInitialScan();
            state.codelens.refresh();
            void vscode.window.showInformationMessage('Tsk: cache rebuilt.');
        }),
    );
}

function readLogLevel(): LogLevel {
    const value = vscode.workspace
        .getConfiguration('tsk')
        .get<string>(LOG_LEVEL_KEY, DEFAULT_LOG_LEVEL);
    if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
        return value;
    }
    return 'info';
}

async function runInitialScan(): Promise<void> {
    if (!state) return;
    const { cache, graph, codelens, logger, diagnosticsManager } = state;
    const start = Date.now();

    const uris = await vscode.workspace.findFiles('**/*.tsk', '**/node_modules/**');
    let scanned = 0;
    let skipped = 0;

    for (const uri of uris) {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            const cached = cache.getFileMtime(uri.toString());
            if (cached === stat.mtime) {
                // Cache on disk is current, but the in-memory graph is
                // fresh on every activation. Hydrate the graph from the
                // persisted cache so codelens / lookups work without
                // needing a rebuildCache invocation.
                const relationships = cache.getRelationshipsForFile(uri.toString());
                graph.applyFileTasks(uri.toString(), relationships);
                skipped++;
                continue;
            }
            await rescanFromFs(uri);
            scanned++;
        } catch (err) {
            logger.error(`scan failed for ${uri}: ${(err as Error).message}`);
        }
    }

    // After the loop, ensure dup + broken-ref diagnostics + codelens
    // reflect the final graph state. Per-file rescans already fire these,
    // but the all-files-skipped case (every file's mtime matched on cold
    // start) needs the explicit refresh here or the lenses stay empty.
    diagnosticsManager.setGraphDuplicates(graph.getDuplicates());
    diagnosticsManager.setBrokenReferences(graph.getBrokenForwardEdges());
    codelens.refresh();

    const elapsed = Date.now() - start;
    const counts = cache.counts();
    logger.info(
        `initial scan: ${scanned} scanned, ${skipped} unchanged, ${counts.tasks} tasks indexed, ${counts.tags} tags, ${elapsed}ms.`,
    );
}

async function rescanFromFs(uri: vscode.Uri): Promise<void> {
    if (!state) return;
    const { cache, graph, codelens, logger, diagnosticsManager } = state;
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder().decode(bytes);
        const result = cache.rescanFile(uri.toString(), text, stat.mtime);
        graph.applyFileTasks(uri.toString(), result.relationships);
        applyWarnings(uri, result.warnings);
        diagnosticsManager.setGraphDuplicates(graph.getDuplicates());
        diagnosticsManager.setBrokenReferences(graph.getBrokenForwardEdges());
        codelens.refresh();
    } catch (err) {
        logger.error(`rescan failed for ${uri}: ${(err as Error).message}`);
    }
}

function rescanFromDoc(doc: vscode.TextDocument): void {
    if (!state) return;
    const { cache, graph, codelens, diagnosticsManager } = state;
    // In-memory edits don't have a meaningful disk mtime; use `Date.now()`
    // so this rescan supersedes any future on-disk mtime read (mtimes are
    // milliseconds since epoch, so wall-clock time is always >= disk mtime).
    const result = cache.rescanFile(doc.uri.toString(), doc.getText(), Date.now());
    graph.applyFileTasks(doc.uri.toString(), result.relationships);
    applyWarnings(doc.uri, result.warnings);
    diagnosticsManager.setGraphDuplicates(graph.getDuplicates());
    diagnosticsManager.setBrokenReferences(graph.getBrokenForwardEdges());
    codelens.refresh();
}

function scheduleDebouncedRescan(doc: vscode.TextDocument): void {
    if (!state) return;
    scheduleDebounced(state.changeTimers, doc.uri.toString(), DOC_CHANGE_DEBOUNCE_MS, () =>
        rescanFromDoc(doc),
    );
}

function applyWarnings(uri: vscode.Uri, warnings: CacheWarning[]): void {
    if (!state) return;
    const { logger, diagnosticsManager } = state;
    // Log every warning so the chronological record is complete. Note:
    // duplicate-id warnings still log here (cache-internal signal); the
    // diagnostics-side dedup that hides them from the Problems panel
    // happens inside DiagnosticsManager.setScanWarnings so the Output
    // channel keeps its full trace while the Problems panel stays free
    // of the soon-to-be-superseded "graph-owned" copy.
    for (const warning of warnings) {
        logger.warn(`${warning.fileUri}:${warning.line + 1}: ${warning.message}`);
    }
    const uriString = uri.toString();
    diagnosticsManager.setScanWarnings(
        uriString,
        warnings.filter((w) => w.fileUri === uriString),
    );
}

function readPriorityOpacity(): number {
    const value = vscode.workspace
        .getConfiguration('tsk')
        .get<number>(PRIORITY_OPACITY_KEY, DEFAULT_PRIORITY_OPACITY);
    // Clamp defensively — the settings JSON schema enforces 0..1 but a
    // hand-edited settings.json could still smuggle anything in.
    return Math.max(0, Math.min(1, value));
}

function buildMarkerDecorationTypes(): Record<Marker, vscode.TextEditorDecorationType> {
    const out = {} as Record<Marker, vscode.TextEditorDecorationType>;
    for (const def of MARKERS) {
        const options: vscode.DecorationRenderOptions = {};
        if (def.color) options.color = new vscode.ThemeColor(def.color.id);
        if (def.strikethrough) options.textDecoration = 'line-through';
        out[def.name] = vscode.window.createTextEditorDecorationType(options);
    }
    return out;
}

function buildPriorityDecorationTypes(
    opacity: number,
): Record<PriorityLevel, vscode.TextEditorDecorationType> {
    const out = {} as Record<PriorityLevel, vscode.TextEditorDecorationType>;
    for (const def of PRIORITIES) {
        out[def.level] = vscode.window.createTextEditorDecorationType({
            backgroundColor: priorityBackgroundColor(def.level, opacity),
            isWholeLine: true,
        });
    }
    return out;
}

function rebuildPriorityDecorationTypes(): void {
    if (!state) return;
    for (const type of Object.values(state.priorityDecorationTypes)) type.dispose();
    state.priorityDecorationTypes = buildPriorityDecorationTypes(readPriorityOpacity());
    for (const editor of vscode.window.visibleTextEditors) {
        applyDecorationsToEditor(editor);
    }
}

function applyDecorationsToEditor(editor: vscode.TextEditor): void {
    if (!state || !isTskDocument(editor.document)) return;
    const {
        markerDecorationTypes,
        priorityDecorationTypes,
        metadataDecorationType,
        decorationSnapshots,
    } = state;

    const tasks = parseDocument(editor.document.getText());
    const markerRanges = computeMarkerRanges(tasks);
    const priorityRanges = computePriorityRanges(tasks);
    const metadataRanges = computeMetadataRanges(tasks);

    // Apply *every* marker type — including with empty arrays — so a marker
    // that just lost its last instance gets its old decorations cleared.
    const markerSnapshot = {} as Record<Marker, RangeLike[]>;
    for (const def of MARKERS) {
        const ranges = markerRanges.get(def.name) ?? [];
        markerSnapshot[def.name] = ranges;
        editor.setDecorations(markerDecorationTypes[def.name], ranges.map(toVscodeRange));
    }

    const prioritySnapshot = {} as Record<PriorityLevel, RangeLike[]>;
    for (const def of PRIORITIES) {
        const ranges = priorityRanges.get(def.level) ?? [];
        prioritySnapshot[def.level] = ranges;
        editor.setDecorations(priorityDecorationTypes[def.level], ranges.map(toVscodeRange));
    }

    editor.setDecorations(metadataDecorationType, metadataRanges.map(toVscodeRange));

    decorationSnapshots.set(editor.document.uri.toString(), {
        markers: markerSnapshot,
        priorities: prioritySnapshot,
        metadata: metadataRanges,
    });
}

function applyDecorationsForDoc(doc: vscode.TextDocument): void {
    // A single doc can back multiple editors (split panes / multiple groups);
    // each one needs its own setDecorations call.
    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === doc) applyDecorationsToEditor(editor);
    }
}

function scheduleDebouncedDecorate(doc: vscode.TextDocument): void {
    if (!state) return;
    scheduleDebounced(state.decorationTimers, doc.uri.toString(), DOC_CHANGE_DEBOUNCE_MS, () =>
        applyDecorationsForDoc(doc),
    );
}

function toVscodeRange(r: RangeLike): vscode.Range {
    return new vscode.Range(r.startLine, r.startCol, r.endLine, r.endCol);
}
