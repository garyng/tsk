import * as vscode from 'vscode';
import { CacheService, type CacheWarning } from './lib/cache';
import { ensureCacheParentDir, IN_MEMORY, resolveCachePath } from './lib/cache-path';
import { Db } from './lib/db';
import { Logger, type LogLevel } from './lib/logger';

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

let state: ActivationState | undefined;

interface ActivationState {
    db: Db;
    cache: CacheService;
    logger: Logger;
    diagnostics: vscode.DiagnosticCollection;
    changeTimers: Map<string, NodeJS.Timeout>;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
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

    state = { db, cache, logger, diagnostics, changeTimers: new Map() };

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('tsk.log.level')) {
                logger.setLevel(readLogLevel());
                logger.info(`log level changed to ${readLogLevel()}.`);
            }
        }),
    );

    await runInitialScan();

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.tsk');
    context.subscriptions.push(
        watcher,
        watcher.onDidCreate((uri) => void rescanFromFs(uri)),
        watcher.onDidChange((uri) => void rescanFromFs(uri)),
        watcher.onDidDelete((uri) => {
            state?.cache.removeFile(uri.toString());
            state?.diagnostics.delete(uri);
        }),
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (doc.languageId === TSK_LANGUAGE_ID) rescanFromDoc(doc);
        }),
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document.languageId !== TSK_LANGUAGE_ID) return;
            scheduleDebouncedRescan(event.document);
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
}

export function deactivate(): void {
    state?.logger.info('tsk extension deactivated.');
    if (state) {
        for (const timer of state.changeTimers.values()) clearTimeout(timer);
        state.changeTimers.clear();
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
