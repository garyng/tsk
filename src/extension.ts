import * as vscode from 'vscode';
import { CacheService, type CacheWarning } from './lib/cache';
import { ensureCacheParentDir, IN_MEMORY, resolveCachePath } from './lib/cache-path';
import { type CacheCounts, Db, type TaskRecord } from './lib/db';
import {
    computeMarkerRanges,
    computePriorityRanges,
    priorityBackgroundColor,
    type RangeLike,
} from './lib/decorations';
import { Logger, type LogLevel } from './lib/logger';
import { MARKERS, type Marker } from './lib/markers';
import { parseDocument } from './lib/parser';
import { PRIORITIES, type PriorityLevel } from './lib/priorities';

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
}

export interface DecorationSnapshot {
    markers: Record<Marker, RangeLike[]>;
    priorities: Record<PriorityLevel, RangeLike[]>;
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

const DOC_CHANGE_DEBOUNCE_MS = 300;
const TSK_LANGUAGE_ID = 'tsk';
const PRIORITY_OPACITY_SETTING = 'tsk.decorations.priority.opacity';
const PRIORITY_OPACITY_KEY = 'decorations.priority.opacity';
const DEFAULT_PRIORITY_OPACITY = 0.15;

let state: ActivationState | undefined;

interface ActivationState {
    db: Db;
    cache: CacheService;
    logger: Logger;
    diagnostics: vscode.DiagnosticCollection;
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
    /** Per-URI snapshot of last-applied decoration ranges (for the e2e API). */
    decorationSnapshots: Map<string, DecorationSnapshot>;
}

export async function activate(context: vscode.ExtensionContext): Promise<TskExtensionApi> {
    const channel = vscode.window.createOutputChannel('tsk');
    context.subscriptions.push(channel);

    const logger = new Logger(channel, readLogLevel());
    logger.info('tsk extension activating.');

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const rawSetting = vscode.workspace.getConfiguration('tsk').get<string>('cache.path', '');
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

    const diagnostics = vscode.languages.createDiagnosticCollection('tsk');
    context.subscriptions.push(diagnostics);

    // Marker decoration types: built once, live for the whole activation.
    const markerDecorationTypes = buildMarkerDecorationTypes();
    for (const type of Object.values(markerDecorationTypes)) context.subscriptions.push(type);

    // Priority decoration types: rebuilt on opacity change, so register a
    // single disposer that walks the *current* set held in state.
    const priorityDecorationTypes = buildPriorityDecorationTypes(readPriorityOpacity());
    context.subscriptions.push({
        dispose: () => {
            if (!state) return;
            for (const type of Object.values(state.priorityDecorationTypes)) type.dispose();
        },
    });

    state = {
        db,
        cache,
        logger,
        diagnostics,
        changeTimers: new Map(),
        decorationTimers: new Map(),
        markerDecorationTypes,
        priorityDecorationTypes,
        decorationSnapshots: new Map(),
    };

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('tsk.log.level')) {
                logger.setLevel(readLogLevel());
                logger.info(`log level changed to ${readLogLevel()}.`);
            }
            if (event.affectsConfiguration(PRIORITY_OPACITY_SETTING)) {
                rebuildPriorityDecorationTypes();
                logger.info(`priority opacity changed to ${readPriorityOpacity()}.`);
            }
        }),
    );

    await runInitialScan();

    // workspaceContains activation can fire with `.tsk` editors already visible
    // (e.g. when restoring a previous session). Decorate them right after the
    // initial scan finishes.
    for (const editor of vscode.window.visibleTextEditors) {
        applyDecorationsToEditor(editor);
    }

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.tsk');
    context.subscriptions.push(
        watcher,
        watcher.onDidCreate((uri) => void rescanFromFs(uri)),
        watcher.onDidChange((uri) => void rescanFromFs(uri)),
        watcher.onDidDelete((uri) => {
            state?.cache.removeFile(uri.toString());
            state?.diagnostics.delete(uri);
            state?.decorationSnapshots.delete(uri.toString());
        }),
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (doc.languageId !== TSK_LANGUAGE_ID) return;
            rescanFromDoc(doc);
            applyDecorationsForDoc(doc);
        }),
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document.languageId !== TSK_LANGUAGE_ID) return;
            scheduleDebouncedRescan(event.document);
            scheduleDebouncedDecorate(event.document);
        }),
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) applyDecorationsToEditor(editor);
        }),
    );

    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            for (const editor of editors) applyDecorationsToEditor(editor);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tsk.rebuildCache', async () => {
            if (!state) return;
            state.logger.info('tsk.rebuildCache invoked.');
            state.diagnostics.clear();
            state.cache.purge();
            await runInitialScan();
            void vscode.window.showInformationMessage('Tsk: cache rebuilt.');
        }),
    );

    logger.info('tsk extension activated.');

    return {
        counts: () => cache.counts(),
        findTaskById: (id) => cache.lookupById(id),
        listAllTags: () => cache.listAllTags(),
        getDecorations: (uri) => state?.decorationSnapshots.get(uri),
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

function readLogLevel(): LogLevel {
    const value = vscode.workspace.getConfiguration('tsk').get<string>('log.level', 'info');
    if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
        return value;
    }
    return 'info';
}

async function runInitialScan(): Promise<void> {
    if (!state) return;
    const { cache, logger } = state;
    const start = Date.now();

    const uris = await vscode.workspace.findFiles('**/*.tsk', '**/node_modules/**');
    let scanned = 0;
    let skipped = 0;

    for (const uri of uris) {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            const cached = cache.getFileMtime(uri.toString());
            if (cached === stat.mtime) {
                skipped++;
                continue;
            }
            await rescanFromFs(uri);
            scanned++;
        } catch (err) {
            logger.error(`scan failed for ${uri}: ${(err as Error).message}`);
        }
    }

    const elapsed = Date.now() - start;
    const counts = cache.counts();
    logger.info(
        `initial scan: ${scanned} scanned, ${skipped} unchanged, ${counts.tasks} tasks indexed, ${counts.tags} tags, ${elapsed}ms.`,
    );
}

async function rescanFromFs(uri: vscode.Uri): Promise<void> {
    if (!state) return;
    const { cache, logger } = state;
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder().decode(bytes);
        const result = cache.rescanFile(uri.toString(), text, stat.mtime);
        applyWarnings(uri, result.warnings);
    } catch (err) {
        logger.error(`rescan failed for ${uri}: ${(err as Error).message}`);
    }
}

function rescanFromDoc(doc: vscode.TextDocument): void {
    if (!state) return;
    // In-memory edits don't have a meaningful disk mtime; use `Date.now()`
    // so this rescan supersedes any future on-disk mtime read (mtimes are
    // milliseconds since epoch, so wall-clock time is always >= disk mtime).
    const result = state.cache.rescanFile(doc.uri.toString(), doc.getText(), Date.now());
    applyWarnings(doc.uri, result.warnings);
}

function scheduleDebouncedRescan(doc: vscode.TextDocument): void {
    if (!state) return;
    const key = doc.uri.toString();
    const existing = state.changeTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        state?.changeTimers.delete(key);
        rescanFromDoc(doc);
    }, DOC_CHANGE_DEBOUNCE_MS);
    state.changeTimers.set(key, timer);
}

function applyWarnings(uri: vscode.Uri, warnings: CacheWarning[]): void {
    if (!state) return;
    const { logger, diagnostics } = state;
    // Log every warning so the chronological record is complete.
    for (const warning of warnings) {
        logger.warn(`${warning.fileUri}:${warning.line + 1}: ${warning.message}`);
    }
    // Replace this file's diagnostics with the warnings keyed to it.
    const uriString = uri.toString();
    const fileDiagnostics = warnings
        .filter((w) => w.fileUri === uriString)
        .map(
            (w) =>
                new vscode.Diagnostic(
                    new vscode.Range(w.line, 0, w.line, w.columnEnd),
                    w.message,
                    vscode.DiagnosticSeverity.Warning,
                ),
        );
    diagnostics.set(uri, fileDiagnostics);
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
    if (!state || editor.document.languageId !== TSK_LANGUAGE_ID) return;
    const { markerDecorationTypes, priorityDecorationTypes, decorationSnapshots } = state;

    const tasks = parseDocument(editor.document.getText());
    const markerRanges = computeMarkerRanges(tasks);
    const priorityRanges = computePriorityRanges(tasks);

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

    decorationSnapshots.set(editor.document.uri.toString(), {
        markers: markerSnapshot,
        priorities: prioritySnapshot,
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
    const key = doc.uri.toString();
    const existing = state.decorationTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        state?.decorationTimers.delete(key);
        applyDecorationsForDoc(doc);
    }, DOC_CHANGE_DEBOUNCE_MS);
    state.decorationTimers.set(key, timer);
}

function toVscodeRange(r: RangeLike): vscode.Range {
    return new vscode.Range(r.startLine, r.startCol, r.endLine, r.endCol);
}
