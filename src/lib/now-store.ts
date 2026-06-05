import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { IN_MEMORY } from './cache-path';
import { generateId } from './ids';
import {
    clear as clearTree,
    currentNowId,
    markNow as markNowTree,
    NOW_TREE_VERSION,
    type NowEntry,
    type NowTreeState,
    normalizeNowTreeState,
    pruneChildren as pruneChildrenTree,
    pruneOffPath as pruneOffPathTree,
    pruneSubtree as pruneSubtreeTree,
    removeEntry as removeEntryTree,
    switchTo as switchToTree,
} from './now-tree';
import { localTimestamp } from './time';

/**
 * Durable home for the "now" undo-tree — its own SQLite `state.db`, kept
 * deliberately SEPARATE from the rebuildable `cache.db` so `Tsk: Rebuild Cache`
 * (which only `DELETE`s from the cache connection) can't touch it. Holds the
 * tree in memory as the session's source of truth, write-through-persists every
 * mutation in one transaction, and notifies subscribers via {@link onDidChange}.
 *
 * Intentionally vscode-free (node:sqlite + a tiny emitter), so it unit-tests
 * against a real temp `state.db` exactly like {@link Db}. The mutators are thin
 * wrappers over the pure `now-tree` reducers; the caller injects fresh ids +
 * timestamps so behaviour stays deterministic in tests. Consumers use the
 * structural `onDidChange(listener): Disposable` / `dispose()` shape, which
 * vscode accepts without us importing it.
 */

const META_CURRENT = 'current_entry_id';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS now_entry (
    entry_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    marked_at TEXT NOT NULL,
    parent_id TEXT,
    created_seq INTEGER NOT NULL,
    content TEXT
);

CREATE TABLE IF NOT EXISTS now_meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
`;

/** Injected so tests get deterministic ids/timestamps; defaults to the real ones. */
export interface NowStoreDeps {
    generateId: () => string;
    now: () => string;
}

export interface NowStoreOptions {
    deps?: NowStoreDeps;
    /** Called (never thrown) when a hand-corrupted `state.db` is discarded on load. */
    warn?: (message: string) => void;
}

interface Stmts {
    listEntries: StatementSync;
    insertEntry: StatementSync;
    deleteEntries: StatementSync;
    getMeta: StatementSync;
    setMeta: StatementSync;
    deleteMeta: StatementSync;
}

export class NowStore {
    private readonly db: DatabaseSync;
    private readonly stmts: Stmts;
    private readonly deps: NowStoreDeps;
    private readonly warn: ((message: string) => void) | undefined;
    private readonly listeners = new Set<() => void>();
    private state: NowTreeState;

    constructor(path: string, options: NowStoreOptions = {}) {
        this.deps = options.deps ?? { generateId, now: localTimestamp };
        this.warn = options.warn;
        this.db = new DatabaseSync(path);
        // WAL is meaningless for `:memory:` (sqlite reports "memory" anyway).
        if (path !== IN_MEMORY) this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
        // Read the on-disk schema version BEFORE stamping ours. A fresh DB
        // reports 0; a DB written by a DIFFERENT NOW_TREE_VERSION holds rows we
        // can't read through the current column mapping, so discard them (start
        // empty + warn) rather than misreading. (Previously user_version was
        // written unconditionally and never read back, so the load-time
        // `version !== NOW_TREE_VERSION` guard was a tautology.)
        const versionRow = this.db.prepare('PRAGMA user_version').get() as
            | { user_version: number }
            | undefined;
        const onDiskVersion = versionRow?.user_version ?? 0;
        this.db.exec(SCHEMA);
        if (onDiskVersion !== 0 && onDiskVersion !== NOW_TREE_VERSION) {
            this.warn?.(
                `now state.db is schema v${onDiskVersion}, expected v${NOW_TREE_VERSION}; discarding it.`,
            );
            this.db.exec('DELETE FROM now_entry');
            this.db.exec('DELETE FROM now_meta');
        }
        this.db.exec(`PRAGMA user_version = ${NOW_TREE_VERSION}`);
        this.stmts = {
            listEntries: this.db.prepare(
                `SELECT entry_id, task_id, marked_at, parent_id, created_seq, content
                 FROM now_entry ORDER BY created_seq`,
            ),
            insertEntry: this.db.prepare(
                `INSERT INTO now_entry (entry_id, task_id, marked_at, parent_id, created_seq, content)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            ),
            deleteEntries: this.db.prepare('DELETE FROM now_entry'),
            getMeta: this.db.prepare('SELECT value FROM now_meta WHERE key = ?'),
            setMeta: this.db.prepare(
                `INSERT INTO now_meta (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            ),
            deleteMeta: this.db.prepare('DELETE FROM now_meta'),
        };
        this.state = this.load();
    }

    /** The current tree (the in-memory source of truth for the session). */
    getState(): NowTreeState {
        return this.state;
    }

    /** The current node's task `@id`, or `null` when nothing is current. */
    getCurrentNowId(): string | null {
        return currentNowId(this.state);
    }

    /** Mark a task `@id` as the current now (a fresh node — see `now-tree`). */
    markNow(id: string, content?: string): void {
        this.apply(
            markNowTree(this.state, {
                entryId: this.deps.generateId(),
                id,
                markedAt: this.deps.now(),
                ...(content !== undefined ? { content } : {}),
            }),
        );
    }

    switchTo(entryId: string): void {
        this.apply(switchToTree(this.state, entryId));
    }

    removeEntry(entryId: string): void {
        this.apply(removeEntryTree(this.state, entryId));
    }

    pruneSubtree(entryId: string): void {
        this.apply(pruneSubtreeTree(this.state, entryId));
    }

    pruneChildren(entryId: string): void {
        this.apply(pruneChildrenTree(this.state, entryId));
    }

    pruneOffPath(): void {
        this.apply(pruneOffPathTree(this.state));
    }

    clear(): void {
        if (this.state.entries.length === 0 && this.state.currentEntryId === null) return;
        this.apply(clearTree(this.state));
    }

    /** Subscribe to changes; the reducer's same-ref no-ops do NOT fire. */
    onDidChange(listener: () => void): { dispose(): void } {
        this.listeners.add(listener);
        return {
            dispose: () => {
                this.listeners.delete(listener);
            },
        };
    }

    dispose(): void {
        this.listeners.clear();
        this.db.close();
    }

    // ── internals ───────────────────────────────────────────────────────────

    private apply(next: NowTreeState): void {
        if (next === this.state) return; // pure reducer returned the same state — nothing changed
        // Persist BEFORE advancing the in-memory state: if the write throws, the
        // in-memory tree stays consistent with disk (no advanced-but-unpersisted
        // state, and listeners aren't notified of a change that didn't land).
        this.persist(next);
        this.state = next;
        for (const listener of [...this.listeners]) listener();
    }

    private load(): NowTreeState {
        const entries = this.stmts.listEntries.all().map(toEntry);
        const row = this.stmts.getMeta.get(META_CURRENT) as { value: string | null } | undefined;
        const currentEntryId = row ? row.value : null;
        return normalizeNowTreeState(
            { version: NOW_TREE_VERSION, entries, currentEntryId },
            this.warn,
        );
    }

    private persist(state: NowTreeState): void {
        this.transaction(() => {
            this.stmts.deleteEntries.run();
            this.stmts.deleteMeta.run();
            for (const e of state.entries) {
                this.stmts.insertEntry.run(
                    e.entryId,
                    e.id,
                    e.markedAt,
                    e.parentId,
                    e.createdSeq,
                    e.content ?? null,
                );
            }
            this.stmts.setMeta.run(META_CURRENT, state.currentEntryId);
        });
    }

    private transaction(fn: () => void): void {
        this.db.exec('BEGIN');
        try {
            fn();
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }
}

/** snake_case row → camelCase {@link NowEntry}. Values are re-validated by `normalizeNowTreeState`. */
function toEntry(row: Record<string, unknown>): NowEntry {
    const content = row.content;
    return {
        entryId: row.entry_id as string,
        id: row.task_id as string,
        markedAt: row.marked_at as string,
        parentId: (row.parent_id ?? null) as string | null,
        createdSeq: row.created_seq as number,
        ...(typeof content === 'string' ? { content } : {}),
    };
}
