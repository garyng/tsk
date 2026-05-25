import type { CacheCounts, Db, TaskRecord } from './db';
import { parseDocument } from './parser';

/**
 * A warning produced during a file rescan. The activation layer (M3/D)
 * surfaces it per the **Warnings convention**: log line in the Output
 * channel + `vscode.Diagnostic` squiggle on `(line, 0)..(line, columnEnd)`.
 */
export interface CacheWarning {
    kind: 'duplicate-id' | 'no-id';
    fileUri: string;
    /** Zero-indexed line, matching VSCode's `Position.line`. */
    line: number;
    /** Length of the offending line, for building a Range. */
    columnEnd: number;
    /** Human-readable text used for both log and diagnostic message. */
    message: string;
    /** For `duplicate-id`: the conflicting `@id` value. */
    id?: string;
    /** For `duplicate-id`: the location of the kept (first) occurrence. */
    firstOccurrence?: { fileUri: string; line: number };
}

export interface RescanResult {
    /** Tasks successfully cached. */
    inserted: number;
    /** Tasks skipped due to warnings (no-id, duplicate-id). */
    skipped: number;
    /** Warnings to surface. */
    warnings: CacheWarning[];
}

/**
 * Orchestrates `Db` + `parseDocument` to keep the cache in sync with `.tsk`
 * files. The whole rescan happens inside a `Db` transaction so partial
 * failure rolls back cleanly. Pure logic — no `vscode` import, no I/O
 * beyond the `Db`. The activation layer adapts file events into calls here.
 */
export class CacheService {
    constructor(private readonly db: Db) {}

    /**
     * Replace a file's cache entries with a fresh scan of `text`.
     *
     * - Cascade-deletes the existing rows for this file (tasks → metadata,
     *   tags via FK).
     * - Re-inserts each `parseDocument`-returned task and its metadata/tags.
     * - Skips tasks that lack an `@id` (returns a `no-id` warning).
     * - Skips tasks whose `@id` is already cached (returns a `duplicate-id`
     *   warning naming the first-occurrence location — spec: first wins).
     *
     * Idempotent: rescanning the same `text` twice produces the same state
     * and the same warnings.
     */
    rescanFile(uri: string, text: string, mtime: number): RescanResult {
        return this.db.transaction(() => {
            this.db.deleteFile(uri);
            this.db.upsertFile(uri, mtime);

            const warnings: CacheWarning[] = [];
            let inserted = 0;
            let skipped = 0;

            for (const task of parseDocument(text)) {
                const id = task.metadata.get('id');

                if (!id) {
                    warnings.push({
                        kind: 'no-id',
                        fileUri: uri,
                        line: task.line,
                        columnEnd: task.raw.length,
                        message:
                            "Task has no @id — won't participate in codelens, tag-find, or graph lookups until one is added.",
                    });
                    skipped++;
                    continue;
                }

                const ok = this.db.insertTask({
                    id,
                    fileUri: uri,
                    line: task.line,
                    marker: task.marker,
                    content: task.content,
                    raw: task.raw,
                });

                if (!ok) {
                    const existing = this.db.findTaskById(id);
                    const where = existing
                        ? `${existing.fileUri}:${existing.line + 1}`
                        : 'unknown location';
                    warnings.push({
                        kind: 'duplicate-id',
                        fileUri: uri,
                        line: task.line,
                        columnEnd: task.raw.length,
                        message: `Duplicate @id "${id}" — first occurrence at ${where} takes precedence.`,
                        id,
                        firstOccurrence: existing
                            ? { fileUri: existing.fileUri, line: existing.line }
                            : undefined,
                    });
                    skipped++;
                    continue;
                }

                inserted++;

                for (const [key, value] of task.metadata) {
                    this.db.insertMetadata({ taskId: id, key, value });
                }
                for (const tag of task.tags) {
                    this.db.insertTag({ taskId: id, tag });
                }
            }

            return { inserted, skipped, warnings };
        });
    }

    /** Remove a file's cache entries entirely (cascade-deletes tasks/metadata/tags). */
    removeFile(uri: string): void {
        this.db.deleteFile(uri);
    }

    /** Drop everything. Used by the `tsk.rebuildCache` command before a fresh scan. */
    purge(): void {
        this.db.purge();
    }

    lookupById(id: string): TaskRecord | undefined {
        return this.db.findTaskById(id);
    }

    listAllTags(): string[] {
        return this.db.listAllTags();
    }

    counts(): CacheCounts {
        return this.db.counts();
    }
}
