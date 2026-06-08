import * as vscode from 'vscode';
import type { CodelensHandle } from './codelens';
import type { DiagnosticsManager } from './diagnostics-manager';
import type { CacheService, CacheWarning, RescanResult } from './lib/cache';
import { cancelDebounced, scheduleDebounced } from './lib/debounce';
import type { GraphService } from './lib/graph-service';
import type { Logger } from './lib/logger';

/**
 * Owns the cache-rescan orchestration: the initial workspace scan, per-file
 * rescans (from disk or from an in-memory document), the debounced change
 * rescan, file removal, and the full rebuild. After every cache mutation it
 * refreshes the graph-derived diagnostics (duplicate-id, broken-ref) and the
 * codelens — that "rescan tail" is one private helper shared by every path.
 *
 * Glue (vscode), extracted from `extension.ts`. The cache / graph / diagnostics
 * / codelens are injected — they're shared with the command + API layers — so
 * this controller owns only the orchestration and the per-URI change-debounce
 * timers.
 */
export class ScanController {
    private readonly changeTimers = new Map<string, NodeJS.Timeout>();

    constructor(
        private readonly cache: CacheService,
        private readonly graph: GraphService,
        private readonly diagnosticsManager: DiagnosticsManager,
        private readonly codelens: CodelensHandle,
        private readonly logger: Logger,
        /**
         * Fired at the end of the shared rescan tail (every cache mutation +
         * rebuild). The now-decoration re-resolves here so an external / line-
         * shifting edit or a `Tsk: Rebuild Cache` re-paints the current-now line.
         */
        private readonly onRescanComplete?: () => void,
    ) {}

    /**
     * Scan `**​/*.tsk` (excluding node_modules) on activation. A file whose disk
     * mtime matches the persisted cache is hydrated into the (always-fresh)
     * in-memory graph without a re-parse; a changed file gets a full rescan.
     */
    async runInitialScan(): Promise<void> {
        const start = Date.now();
        const uris = await vscode.workspace.findFiles('**/*.tsk', '**/node_modules/**');
        let scanned = 0;
        let skipped = 0;

        for (const uri of uris) {
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (this.cache.getFileMtime(uri.toString()) === stat.mtime) {
                    // Cache on disk is current, but the in-memory graph is fresh
                    // on every activation. Hydrate it from the persisted cache so
                    // codelens / lookups work without a rebuildCache invocation.
                    this.graph.applyFileTasks(
                        uri.toString(),
                        this.cache.getRelationshipsForFile(uri.toString()),
                    );
                    skipped++;
                    continue;
                }
                await this.rescanFromFs(uri);
                scanned++;
            } catch (err) {
                this.logger.error(`scan failed for ${uri}: ${(err as Error).message}`);
            }
        }

        // The all-files-skipped case (every mtime matched on cold start) never
        // hit a per-file tail, so refresh once here or the lenses stay empty.
        this.refreshDiagnosticsAndLenses();

        const elapsed = Date.now() - start;
        const counts = this.cache.counts();
        this.logger.info(
            `initial scan: ${scanned} scanned, ${skipped} unchanged, ${counts.tasks} tasks indexed, ${counts.tags} tags, ${elapsed}ms.`,
        );
    }

    /** Re-read `uri` from disk and rescan it (FileSystemWatcher create / change). */
    async rescanFromFs(uri: vscode.Uri): Promise<void> {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = new TextDecoder().decode(bytes);
            const result = this.cache.rescanFile(uri.toString(), text, stat.mtime);
            this.applyRescanResult(uri.toString(), result);
        } catch (err) {
            this.logger.error(`rescan failed for ${uri}: ${(err as Error).message}`);
        }
    }

    /** Rescan from an in-memory document (save / debounced change). */
    rescanFromDoc(doc: vscode.TextDocument): void {
        // In-memory edits have no meaningful disk mtime; `Date.now()` supersedes
        // any future on-disk mtime read (mtimes are ms since epoch, so wall-clock
        // time is always >= a disk mtime).
        const result = this.cache.rescanFile(doc.uri.toString(), doc.getText(), Date.now());
        this.applyRescanResult(doc.uri.toString(), result);
    }

    /** Debounced `rescanFromDoc`, keyed per URI. */
    scheduleRescan(doc: vscode.TextDocument, debounceMs: number): void {
        scheduleDebounced(this.changeTimers, doc.uri.toString(), debounceMs, () =>
            this.rescanFromDoc(doc),
        );
    }

    /**
     * Cancel a pending change-rescan timer for one URI — mirrors
     * `DecorationsController.evict`'s timer eviction. Called when the file is
     * deleted or its document closed, so a queued `rescanFromDoc` can't fire
     * against the gone file and re-insert (resurrect) its tasks.
     */
    cancelScheduled(uriString: string): void {
        cancelDebounced(this.changeTimers, uriString);
    }

    /** Drop a deleted file from the cache + graph + diagnostics, then refresh. */
    removeFile(uriString: string): void {
        // Revoke any in-flight debounced rescan first; otherwise an edit-then-
        // delete within the debounce window resurrects the just-removed file.
        this.cancelScheduled(uriString);
        this.cache.removeFile(uriString);
        this.graph.removeFile(uriString);
        this.diagnosticsManager.deleteFile(uriString);
        this.refreshDiagnosticsAndLenses();
    }

    /** Purge everything and re-scan from scratch (the `tsk.rebuildCache` command). */
    async rebuild(): Promise<void> {
        this.diagnosticsManager.clear();
        this.cache.purge();
        this.graph.purge();
        await this.runInitialScan();
        this.codelens.refresh();
    }

    /** Cancel all pending change-rescan timers (deactivation). */
    clearTimers(): void {
        for (const timer of this.changeTimers.values()) clearTimeout(timer);
        this.changeTimers.clear();
    }

    /** Apply a cache rescan result to the graph, then the shared tail. */
    private applyRescanResult(uriString: string, result: RescanResult): void {
        this.graph.applyFileTasks(uriString, result.relationships);
        this.applyWarnings(uriString, result.warnings);
        this.refreshDiagnosticsAndLenses();
    }

    /** Log every scan warning + push the file's diagnostics. */
    private applyWarnings(uriString: string, warnings: CacheWarning[]): void {
        // Log every warning so the chronological record is complete; duplicate-id
        // warnings still log here (cache-internal signal), while the diagnostics-
        // side dedup that hides them from the Problems panel happens inside
        // DiagnosticsManager.setScanWarnings.
        for (const warning of warnings) {
            this.logger.warn(`${warning.fileUri}:${warning.line + 1}: ${warning.message}`);
        }
        this.diagnosticsManager.setScanWarnings(
            uriString,
            warnings.filter((w) => w.fileUri === uriString),
        );
    }

    /** The shared "rescan tail": refresh graph-derived diagnostics + lenses. */
    private refreshDiagnosticsAndLenses(): void {
        this.diagnosticsManager.setGraphDuplicates(this.graph.getDuplicates());
        this.diagnosticsManager.setBrokenReferences(this.graph.getBrokenForwardEdges());
        this.codelens.refresh();
        this.onRescanComplete?.();
    }
}
