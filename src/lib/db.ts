import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Marker } from './parser';
import { openDatabase, transaction as runTransaction } from './sqlite';

/**
 * Thin wrapper over `node:sqlite`. Owns the connection, applies the schema
 * once on construction, and exposes typed CRUD primitives that higher layers
 * (the `CacheService` in M3/C) compose into file-scoped rescans.
 *
 * - WAL mode + relaxed synchronous for concurrent-window tolerance.
 * - `foreign_keys = ON` so deleting a file row cascades to its tasks, and each
 *   task to its metadata/tags, in one statement.
 * - All schema DDL is `IF NOT EXISTS`, so re-opening an existing DB is a
 *   no-op for tables (the data survives).
 *
 * **Occurrence store.** Tasks are keyed by `(file_uri, line)` and EVERY
 * occurrence of an `@id` is stored (duplicates included). `findTaskById`
 * returns the lexicographically-lowest `(file_uri, line)` occurrence — the
 * same canonical-winner rule `graph.ts` applies — so the cache and graph agree
 * by construction, and deleting the winner's file auto-promotes the next
 * occurrence through the FK cascade (no reconcile step). The aggregate reads
 * (`listAllTasks` / `listAllMetadata` / `listAllTaskTags` / `counts.tasks`)
 * filter to the canonical occurrence per id, so a duplicate id counts once.
 */

export interface FileRecord {
    uri: string;
    mtime: number;
}

export interface TaskRecord {
    /** The `@id` value from the task's metadata. Indexed, NOT unique — a
     *  duplicate `@id` is stored as multiple occurrences. */
    id: string;
    fileUri: string;
    line: number;
    marker: Marker;
    content: string;
    /** The original line text, byte-for-byte. */
    raw: string;
}

export interface MetadataRecord {
    taskId: string;
    key: string;
    /** `null` distinguishes `@flag` (no colon) from `''` (`@flag:`). */
    value: string | null;
}

export interface TagDef {
    tag: string;
    description: string | null;
    parent: string | null;
}

export interface CacheCounts {
    files: number;
    tasks: number;
    tags: number;
}

/**
 * SQL predicate: the `alias` task occurrence is canonical — no occurrence of
 * the same id is lexicographically lower by `(file_uri, line)`. Used to fold
 * a duplicate `@id` to its single winner in the aggregate reads.
 */
function canonical(alias: string): string {
    return `NOT EXISTS (
        SELECT 1 FROM tasks c
        WHERE c.id = ${alias}.id
          AND (c.file_uri < ${alias}.file_uri
               OR (c.file_uri = ${alias}.file_uri AND c.line < ${alias}.line)))`;
}

const TASK_COLS = 'id, file_uri, line, marker, content, raw';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
    uri TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    file_uri TEXT NOT NULL,
    line INTEGER NOT NULL,
    id TEXT NOT NULL,
    marker TEXT NOT NULL,
    content TEXT NOT NULL,
    raw TEXT NOT NULL,
    PRIMARY KEY (file_uri, line),
    FOREIGN KEY (file_uri) REFERENCES files(uri) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_file ON tasks(file_uri);
CREATE INDEX IF NOT EXISTS idx_tasks_id ON tasks(id);

CREATE TABLE IF NOT EXISTS metadata (
    file_uri TEXT NOT NULL,
    line INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    FOREIGN KEY (file_uri, line) REFERENCES tasks(file_uri, line) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_metadata_occ ON metadata(file_uri, line);
CREATE INDEX IF NOT EXISTS idx_metadata_key ON metadata(key);

CREATE TABLE IF NOT EXISTS tags (
    file_uri TEXT NOT NULL,
    line INTEGER NOT NULL,
    tag TEXT NOT NULL,
    FOREIGN KEY (file_uri, line) REFERENCES tasks(file_uri, line) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tags_occ ON tags(file_uri, line);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

CREATE TABLE IF NOT EXISTS tag_defs (
    tag TEXT PRIMARY KEY,
    description TEXT,
    parent TEXT
);
`;

interface PreparedStatements {
    upsertFile: StatementSync;
    getFile: StatementSync;
    deleteFile: StatementSync;
    listFiles: StatementSync;
    insertTask: StatementSync;
    listTasksForFile: StatementSync;
    listAllTasks: StatementSync;
    findTaskById: StatementSync;
    insertMetadata: StatementSync;
    listMetadataForOccurrence: StatementSync;
    listAllMetadata: StatementSync;
    insertTag: StatementSync;
    listAllTags: StatementSync;
    listAllTaskTags: StatementSync;
    upsertTagDef: StatementSync;
    getTagDef: StatementSync;
    listTagDefs: StatementSync;
    countFiles: StatementSync;
    countTasks: StatementSync;
    countTags: StatementSync;
}

export class Db {
    private readonly db: DatabaseSync;
    private readonly stmts: PreparedStatements;

    constructor(path: string) {
        // WAL + synchronous hardening is shared via `openDatabase`. cache.db
        // relies on FK cascades (deleting a `files` row wipes its tasks, and
        // each task its metadata/tags), so assert foreign_keys ON explicitly.
        this.db = openDatabase(path);
        this.db.exec('PRAGMA foreign_keys = ON');
        this.db.exec(SCHEMA);
        this.stmts = this.prepareStatements();
    }

    private prepareStatements(): PreparedStatements {
        const p = (sql: string): StatementSync => this.db.prepare(sql);
        return {
            upsertFile: p(
                `INSERT INTO files (uri, mtime) VALUES (?, ?)
                 ON CONFLICT(uri) DO UPDATE SET mtime = excluded.mtime`,
            ),
            getFile: p('SELECT uri, mtime FROM files WHERE uri = ?'),
            deleteFile: p('DELETE FROM files WHERE uri = ?'),
            listFiles: p('SELECT uri, mtime FROM files ORDER BY uri'),

            insertTask: p(
                `INSERT INTO tasks (file_uri, line, id, marker, content, raw)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            ),
            listTasksForFile: p(`SELECT ${TASK_COLS} FROM tasks WHERE file_uri = ? ORDER BY line`),
            listAllTasks: p(
                `SELECT ${TASK_COLS} FROM tasks t WHERE ${canonical('t')} ORDER BY file_uri, line`,
            ),
            // Canonical (lex-lowest occurrence) — the graph's winner rule.
            findTaskById: p(
                `SELECT ${TASK_COLS} FROM tasks WHERE id = ? ORDER BY file_uri, line LIMIT 1`,
            ),

            insertMetadata: p(
                'INSERT INTO metadata (file_uri, line, key, value) VALUES (?, ?, ?, ?)',
            ),
            listMetadataForOccurrence: p(
                'SELECT key, value FROM metadata WHERE file_uri = ? AND line = ?',
            ),
            listAllMetadata: p(
                `SELECT t.id AS task_id, m.key, m.value
                 FROM metadata m JOIN tasks t ON m.file_uri = t.file_uri AND m.line = t.line
                 WHERE ${canonical('t')}`,
            ),

            insertTag: p('INSERT INTO tags (file_uri, line, tag) VALUES (?, ?, ?)'),
            listAllTags: p('SELECT DISTINCT tag FROM tags ORDER BY tag'),
            listAllTaskTags: p(
                `SELECT t.id AS task_id, tg.tag
                 FROM tags tg JOIN tasks t ON tg.file_uri = t.file_uri AND tg.line = t.line
                 WHERE ${canonical('t')}`,
            ),

            upsertTagDef: p(
                `INSERT INTO tag_defs (tag, description, parent) VALUES (?, ?, ?)
                 ON CONFLICT(tag) DO UPDATE SET
                   description = excluded.description,
                   parent = excluded.parent`,
            ),
            getTagDef: p('SELECT tag, description, parent FROM tag_defs WHERE tag = ?'),
            listTagDefs: p('SELECT tag, description, parent FROM tag_defs ORDER BY tag'),

            countFiles: p('SELECT COUNT(*) AS n FROM files'),
            countTasks: p('SELECT COUNT(DISTINCT id) AS n FROM tasks'),
            countTags: p('SELECT COUNT(DISTINCT tag) AS n FROM tags'),
        };
    }

    // ── Files ───────────────────────────────────────────────────────────────
    upsertFile(uri: string, mtime: number): void {
        this.stmts.upsertFile.run(uri, mtime);
    }

    getFile(uri: string): FileRecord | undefined {
        const row = this.stmts.getFile.get(uri);
        return row ? toFile(row) : undefined;
    }

    deleteFile(uri: string): void {
        this.stmts.deleteFile.run(uri);
    }

    listFiles(): FileRecord[] {
        return this.stmts.listFiles.all().map(toFile);
    }

    // ── Tasks ───────────────────────────────────────────────────────────────
    /**
     * Insert a task occurrence, keyed by `(file_uri, line)`. Every occurrence
     * is stored — a duplicate `@id` yields multiple rows; {@link findTaskById}
     * resolves the canonical one. Occurrences never collide on `(file_uri,
     * line)` (one task per line), so no conflict handling is needed.
     */
    insertTask(task: TaskRecord): void {
        this.stmts.insertTask.run(
            task.fileUri,
            task.line,
            task.id,
            task.marker,
            task.content,
            task.raw,
        );
    }

    listTasksForFile(uri: string): TaskRecord[] {
        return this.stmts.listTasksForFile.all(uri).map(toTask);
    }

    /** Every canonical task (one per id) across all files; used by the picker UX. */
    listAllTasks(): TaskRecord[] {
        return this.stmts.listAllTasks.all().map(toTask);
    }

    /** The canonical (lex-lowest `(fileUri, line)`) occurrence of `id`, or undefined. */
    findTaskById(id: string): TaskRecord | undefined {
        const row = this.stmts.findTaskById.get(id);
        return row ? toTask(row) : undefined;
    }

    // ── Metadata ────────────────────────────────────────────────────────────
    insertMetadata(fileUri: string, line: number, key: string, value: string | null): void {
        this.stmts.insertMetadata.run(fileUri, line, key, value);
    }

    /** Raw `(key, value)` metadata of one occurrence — for the graph projection. */
    listMetadataForOccurrence(
        fileUri: string,
        line: number,
    ): Array<{ key: string; value: string | null }> {
        return this.stmts.listMetadataForOccurrence.all(fileUri, line).map((r) => ({
            key: r.key as string,
            value: r.value as string | null,
        }));
    }

    /**
     * Every `(taskId, key, value)` metadata row of the CANONICAL occurrence per
     * id, in one query — the bulk counterpart to {@link listMetadataForOccurrence}.
     * Feeds the stats aggregation (date-bucketing `@created`/`@started`/…); the
     * canonical filter keeps a duplicate id from double-counting its events.
     */
    listAllMetadata(): MetadataRecord[] {
        return this.stmts.listAllMetadata.all().map(toMetadata);
    }

    // ── Tags ────────────────────────────────────────────────────────────────
    insertTag(fileUri: string, line: number, tag: string): void {
        this.stmts.insertTag.run(fileUri, line, tag);
    }

    listAllTags(): string[] {
        return this.stmts.listAllTags.all().map((r) => r.tag as string);
    }

    /**
     * Every `(taskId, tag)` pair of the CANONICAL occurrence per id, unordered.
     * Feeds the hierarchical task-count computation in `tags-find-logic`; the
     * canonical filter keeps a duplicate id from double-counting its tags.
     */
    listAllTaskTags(): Array<[taskId: string, tag: string]> {
        return this.stmts.listAllTaskTags.all().map((r) => [r.task_id as string, r.tag as string]);
    }

    // ── Tag defs ────────────────────────────────────────────────────────────
    upsertTagDef(tag: string, description: string | null, parent: string | null): void {
        this.stmts.upsertTagDef.run(tag, description, parent);
    }

    getTagDef(tag: string): TagDef | undefined {
        const row = this.stmts.getTagDef.get(tag);
        return row ? toTagDef(row) : undefined;
    }

    listTagDefs(): TagDef[] {
        return this.stmts.listTagDefs.all().map(toTagDef);
    }

    // ── Transactions / maintenance ──────────────────────────────────────────
    transaction<T>(fn: () => T): T {
        return runTransaction(this.db, fn);
    }

    /** Drop all data. Schema and prepared statements remain valid. */
    purge(): void {
        // CASCADE wipes tasks/metadata/tags via the files FK.
        // tag_defs has no FK so it needs an explicit clear.
        this.db.exec('DELETE FROM files');
        this.db.exec('DELETE FROM tag_defs');
    }

    counts(): CacheCounts {
        const f = this.stmts.countFiles.get() as { n: number };
        const t = this.stmts.countTasks.get() as { n: number };
        const g = this.stmts.countTags.get() as { n: number };
        return { files: f.n, tasks: t.n, tags: g.n };
    }

    close(): void {
        this.db.close();
    }
}

// Row converters keep the snake_case → camelCase mapping in one place.

function toFile(row: Record<string, unknown>): FileRecord {
    return { uri: row.uri as string, mtime: row.mtime as number };
}

function toTask(row: Record<string, unknown>): TaskRecord {
    return {
        id: row.id as string,
        fileUri: row.file_uri as string,
        line: row.line as number,
        marker: row.marker as Marker,
        content: row.content as string,
        raw: row.raw as string,
    };
}

function toMetadata(row: Record<string, unknown>): MetadataRecord {
    return {
        taskId: row.task_id as string,
        key: row.key as string,
        value: row.value as string | null,
    };
}

function toTagDef(row: Record<string, unknown>): TagDef {
    return {
        tag: row.tag as string,
        description: row.description as string | null,
        parent: row.parent as string | null,
    };
}
