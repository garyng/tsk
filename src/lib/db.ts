import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Marker } from './parser';

/**
 * Thin wrapper over `node:sqlite`. Owns the connection, applies the schema
 * once on construction, and exposes typed CRUD primitives that higher layers
 * (the `CacheService` in M3/C) compose into file-scoped rescans.
 *
 * - WAL mode + relaxed synchronous for concurrent-window tolerance.
 * - `foreign_keys = ON` so deleting a file row cascades to its tasks,
 *   metadata, and tags in one statement.
 * - All schema DDL is `IF NOT EXISTS`, so re-opening an existing DB is a
 *   no-op for tables (the data survives).
 */

export interface FileRecord {
    uri: string;
    mtime: number;
}

export interface TaskRecord {
    /** The `@id` value from the task's metadata. Primary key — must be set. */
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

export interface TagRecord {
    taskId: string;
    tag: string;
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
    uri TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    file_uri TEXT NOT NULL,
    line INTEGER NOT NULL,
    marker TEXT NOT NULL,
    content TEXT NOT NULL,
    raw TEXT NOT NULL,
    FOREIGN KEY (file_uri) REFERENCES files(uri) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_file ON tasks(file_uri);

CREATE TABLE IF NOT EXISTS metadata (
    task_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_metadata_task ON metadata(task_id);
CREATE INDEX IF NOT EXISTS idx_metadata_key ON metadata(key);

CREATE TABLE IF NOT EXISTS tags (
    task_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tags_task ON tags(task_id);
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
    listMetadataForTask: StatementSync;
    insertTag: StatementSync;
    listTagsForTask: StatementSync;
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
        this.db = new DatabaseSync(path);
        // WAL only meaningful for on-disk databases; sqlite returns "memory"
        // for `:memory:` regardless, so skip the pragma to avoid noise.
        if (path !== ':memory:') {
            this.db.exec('PRAGMA journal_mode = WAL');
        }
        this.db.exec('PRAGMA synchronous = NORMAL');
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
                `INSERT OR IGNORE INTO tasks (id, file_uri, line, marker, content, raw)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            ),
            listTasksForFile: p(
                `SELECT id, file_uri, line, marker, content, raw
                 FROM tasks WHERE file_uri = ? ORDER BY line`,
            ),
            listAllTasks: p(
                `SELECT id, file_uri, line, marker, content, raw
                 FROM tasks ORDER BY file_uri, line`,
            ),
            findTaskById: p(
                `SELECT id, file_uri, line, marker, content, raw
                 FROM tasks WHERE id = ?`,
            ),

            insertMetadata: p('INSERT INTO metadata (task_id, key, value) VALUES (?, ?, ?)'),
            listMetadataForTask: p('SELECT task_id, key, value FROM metadata WHERE task_id = ?'),

            insertTag: p('INSERT INTO tags (task_id, tag) VALUES (?, ?)'),
            listTagsForTask: p('SELECT tag FROM tags WHERE task_id = ? ORDER BY tag'),
            listAllTags: p('SELECT DISTINCT tag FROM tags ORDER BY tag'),
            listAllTaskTags: p('SELECT task_id, tag FROM tags'),

            upsertTagDef: p(
                `INSERT INTO tag_defs (tag, description, parent) VALUES (?, ?, ?)
                 ON CONFLICT(tag) DO UPDATE SET
                   description = excluded.description,
                   parent = excluded.parent`,
            ),
            getTagDef: p('SELECT tag, description, parent FROM tag_defs WHERE tag = ?'),
            listTagDefs: p('SELECT tag, description, parent FROM tag_defs ORDER BY tag'),

            countFiles: p('SELECT COUNT(*) AS n FROM files'),
            countTasks: p('SELECT COUNT(*) AS n FROM tasks'),
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
     * Insert a task. Returns `true` if the row was inserted, `false` if the
     * id already existed (duplicate — first-occurrence wins). Callers should
     * skip writing metadata/tags for the task on `false` to keep their FK
     * targets correct.
     */
    insertTask(task: TaskRecord): boolean {
        const result = this.stmts.insertTask.run(
            task.id,
            task.fileUri,
            task.line,
            task.marker,
            task.content,
            task.raw,
        );
        return Number(result.changes) > 0;
    }

    listTasksForFile(uri: string): TaskRecord[] {
        return this.stmts.listTasksForFile.all(uri).map(toTask);
    }

    /** Enumerate every cached task across all files; used by the picker UX. */
    listAllTasks(): TaskRecord[] {
        return this.stmts.listAllTasks.all().map(toTask);
    }

    findTaskById(id: string): TaskRecord | undefined {
        const row = this.stmts.findTaskById.get(id);
        return row ? toTask(row) : undefined;
    }

    // ── Metadata ────────────────────────────────────────────────────────────
    insertMetadata(record: MetadataRecord): void {
        this.stmts.insertMetadata.run(record.taskId, record.key, record.value);
    }

    listMetadataForTask(taskId: string): MetadataRecord[] {
        return this.stmts.listMetadataForTask.all(taskId).map(toMetadata);
    }

    // ── Tags ────────────────────────────────────────────────────────────────
    insertTag(record: TagRecord): void {
        this.stmts.insertTag.run(record.taskId, record.tag);
    }

    listTagsForTask(taskId: string): string[] {
        return this.stmts.listTagsForTask.all(taskId).map((r) => r.tag as string);
    }

    listAllTags(): string[] {
        return this.stmts.listAllTags.all().map((r) => r.tag as string);
    }

    /**
     * Every `(taskId, tag)` pair across the workspace, unordered. Feeds
     * the hierarchical task-count computation in `tags-find-logic`. One
     * query (no per-task fan-out) so the whole picker count is a single
     * round-trip.
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
        this.db.exec('BEGIN');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
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
