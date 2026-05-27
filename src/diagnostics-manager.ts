import * as vscode from 'vscode';
import type { CacheWarning } from './lib/cache';
import type { DuplicateIdReport } from './lib/graph';

/**
 * Tracks per-file diagnostic state for the tsk extension and merges the
 * two warning sources before writing to `diagnostics.set`:
 *
 *   - **Per-file scan warnings** from `CacheService.rescanFile` — today
 *     only `no-id` after this merge layer filters out `duplicate-id`.
 *     Cache continues to track its own first-insert-wins semantics for
 *     data integrity, but the user-facing dup story is owned by the
 *     graph.
 *   - **Graph-layer duplicate-id reports** from `GraphService.getDuplicates`.
 *     One report per id; emits one diagnostic per occurrence so every
 *     conflicting file gets squiggled, not just the loser as the cache
 *     would do per-rescan.
 *
 * The merge is necessary because `vscode.DiagnosticCollection.set(uri, …)`
 * replaces the URI's collection wholesale — so we can't write scan
 * warnings and graph warnings in two unconditional passes without one
 * clobbering the other.
 */
const ROW_END = Number.MAX_SAFE_INTEGER;

export class DiagnosticsManager {
    private scanWarningsByFile = new Map<string, CacheWarning[]>();
    private graphDuplicates: readonly DuplicateIdReport[] = [];
    /** Files mentioned in the *current* graph dup report; refreshed on each setGraphDuplicates call. */
    private graphFiles = new Set<string>();

    constructor(private readonly collection: vscode.DiagnosticCollection) {}

    /**
     * Update this file's scan warnings (output of the cache layer). Any
     * `duplicate-id` entries are silently filtered — the graph owns that
     * warning kind via `setGraphDuplicates`.
     */
    setScanWarnings(fileUri: string, warnings: readonly CacheWarning[]): void {
        const filtered = warnings.filter((w) => w.kind !== 'duplicate-id');
        if (filtered.length === 0) {
            this.scanWarningsByFile.delete(fileUri);
        } else {
            this.scanWarningsByFile.set(fileUri, [...filtered]);
        }
        this.flushFile(fileUri);
    }

    /**
     * Replace the graph-layer duplicate report. Files that *were* in the
     * previous report but aren't in the new one get flushed (so their
     * diagnostics are cleared), as do all files in the new report.
     */
    setGraphDuplicates(duplicates: readonly DuplicateIdReport[]): void {
        const previousFiles = this.graphFiles;
        const nextFiles = new Set<string>();
        for (const dup of duplicates) {
            for (const occ of dup.occurrences) nextFiles.add(occ.fileUri);
        }
        this.graphDuplicates = duplicates;
        this.graphFiles = nextFiles;

        const affected = new Set<string>([...previousFiles, ...nextFiles]);
        for (const fileUri of affected) {
            this.flushFile(fileUri);
        }
    }

    /** Drop any state for a file (e.g. on delete). */
    deleteFile(fileUri: string): void {
        this.scanWarningsByFile.delete(fileUri);
        this.collection.delete(vscode.Uri.parse(fileUri));
    }

    /** Clear everything. Used during `tsk.rebuildCache`. */
    clear(): void {
        this.scanWarningsByFile.clear();
        this.graphDuplicates = [];
        this.graphFiles.clear();
        this.collection.clear();
    }

    private flushFile(fileUri: string): void {
        const diagnostics: vscode.Diagnostic[] = [];

        const scanWarns = this.scanWarningsByFile.get(fileUri);
        if (scanWarns) {
            for (const w of scanWarns) {
                diagnostics.push(
                    new vscode.Diagnostic(
                        new vscode.Range(w.line, 0, w.line, w.columnEnd),
                        w.message,
                        vscode.DiagnosticSeverity.Warning,
                    ),
                );
            }
        }

        for (const dup of this.graphDuplicates) {
            const canonical = dup.occurrences[0];
            if (!canonical) continue;
            for (const occ of dup.occurrences) {
                if (occ.fileUri !== fileUri) continue;
                const isCanonical =
                    occ.fileUri === canonical.fileUri && occ.line === canonical.line;
                const message = isCanonical
                    ? `Duplicate @id "${dup.id}" — this is the canonical occurrence (${dup.occurrences.length} total).`
                    : `Duplicate @id "${dup.id}" — first occurrence at ${canonical.fileUri}:${canonical.line + 1} takes precedence.`;
                diagnostics.push(
                    new vscode.Diagnostic(
                        new vscode.Range(occ.line, 0, occ.line, ROW_END),
                        message,
                        vscode.DiagnosticSeverity.Warning,
                    ),
                );
            }
        }

        if (diagnostics.length === 0) {
            this.collection.delete(vscode.Uri.parse(fileUri));
        } else {
            this.collection.set(vscode.Uri.parse(fileUri), diagnostics);
        }
    }
}
