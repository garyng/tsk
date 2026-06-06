import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, transaction } from './sqlite';

const pragma = (db: ReturnType<typeof openDatabase>, name: string): unknown =>
    (db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name];

describe('openDatabase', () => {
    it('skips WAL for the :memory: sentinel (sqlite reports "memory")', () => {
        const db = openDatabase(':memory:');
        expect(pragma(db, 'journal_mode')).toBe('memory');
        db.close();
    });

    describe('on-disk', () => {
        let tmp: string;
        beforeEach(() => {
            tmp = mkdtempSync(join(tmpdir(), 'tsk-sqlite-'));
        });
        afterEach(() => {
            rmSync(tmp, { recursive: true, force: true });
        });

        it('enables WAL for a file-backed db', () => {
            const db = openDatabase(join(tmp, 'x.db'));
            expect(pragma(db, 'journal_mode')).toBe('wal');
            db.close();
        });
    });
});

describe('transaction', () => {
    it('commits the writes and returns the result', () => {
        const db = openDatabase(':memory:');
        db.exec('CREATE TABLE t (n INTEGER)');
        const result = transaction(db, () => {
            db.exec('INSERT INTO t (n) VALUES (1)');
            return 'ok';
        });
        expect(result).toBe('ok');
        expect((db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c).toBe(1);
        db.close();
    });

    it('rolls back and re-throws on error', () => {
        const db = openDatabase(':memory:');
        db.exec('CREATE TABLE t (n INTEGER)');
        expect(() =>
            transaction(db, () => {
                db.exec('INSERT INTO t (n) VALUES (1)');
                throw new Error('boom');
            }),
        ).toThrow('boom');
        expect((db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c).toBe(0);
        db.close();
    });
});
