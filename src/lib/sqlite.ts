import { DatabaseSync } from 'node:sqlite';
import { IN_MEMORY } from './cache-path';

/**
 * Shared `node:sqlite` connection primitives for the two tsk databases — the
 * rebuildable `cache.db` ({@link Db}) and the durable `state.db`
 * ({@link NowStore}). Both want the same connection-level hardening (WAL +
 * relaxed synchronous) and the same `BEGIN/COMMIT/ROLLBACK` wrapper, so they go
 * through here and can't drift. The two DB *files* stay deliberately separate
 * (Rebuild Cache must never touch the now-tree) — this shares the open/transact
 * mechanics, not the data.
 */

/**
 * Open a sqlite connection with tsk's standard hardening: WAL journal mode
 * (skipped for the `:memory:` sentinel, where it's meaningless — sqlite reports
 * "memory" regardless) and relaxed `synchronous = NORMAL`. Schema creation,
 * prepared statements, and any DB-specific pragmas (e.g. the cache.db's explicit
 * `foreign_keys = ON` for its FK cascades) stay the caller's job. NB: `node:sqlite`
 * already enables foreign-key constraints by default, so this helper doesn't
 * touch that pragma — callers that depend on cascades assert it themselves.
 */
export function openDatabase(path: string): DatabaseSync {
    const db = new DatabaseSync(path);
    if (path !== IN_MEMORY) db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    return db;
}

/**
 * Run `fn` inside a `BEGIN`/`COMMIT` transaction on `db`, rolling back and
 * re-throwing on any error. Returns `fn`'s result.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
    db.exec('BEGIN');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
