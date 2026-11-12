import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAtDefault, moveOldDefaults } from './old-default-move';

describe('isAtDefault', () => {
    it('is a setting set at no level', () => {
        expect(isAtDefault({ globalValue: undefined })).toBe(true);
        expect(isAtDefault(undefined)).toBe(true);
        expect(isAtDefault({ workspaceValue: '' })).toBe(false);
        expect(isAtDefault({ globalValue: '/x' })).toBe(false);
        expect(isAtDefault({ workspaceFolderValue: '/x' })).toBe(false);
    });
});

describe('moveOldDefaults', () => {
    let root: string;
    let folder: string;
    let old: string;
    let storage: string;
    let logged: string[];
    const log = {
        info: (m: string) => logged.push(`info ${m}`),
        warn: (m: string) => logged.push(`warn ${m}`),
    };

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'tsk-move-test-'));
        folder = join(root, 'repo');
        old = join(folder, '.vscode', 'tsk');
        storage = join(root, 'storage', 'garyng.tsk');
        mkdirSync(old, { recursive: true });
        logged = [];
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    /** A WAL database holding `rows`, left with its `-wal` uncheckpointed (open, as a running VS Code would). */
    function walDatabase(path: string, rows: string[]): DatabaseSync {
        const db = new DatabaseSync(path);
        db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
        db.exec('CREATE TABLE t (v TEXT)');
        for (const r of rows) db.prepare('INSERT INTO t VALUES (?)').run(r);
        return db;
    }
    /** The rows the main file holds without its -wal: copied on its own, so nothing merges it in. */
    const rowsOfMainFileOnly = (path: string) => {
        const alone = join(root, 'alone.db');
        copyFileSync(path, alone);
        try {
            return rowsOf(alone);
        } catch {
            return [];
        }
    };
    const rowsOf = (path: string) => {
        const db = new DatabaseSync(path);
        try {
            return db
                .prepare('SELECT v FROM t')
                .all()
                .map((r) => r.v);
        } finally {
            db.close();
        }
    };

    it("copies the now-tree, with what's still in its -wal, removes the cache, then the emptied folders", () => {
        walDatabase(join(old, 'state.db'), ['a', 'b']).close();
        walDatabase(join(old, 'cache.db'), ['c']).close();

        const to = { cache: join(storage, 'cache.db'), state: join(storage, 'state.db') };
        expect(moveOldDefaults(folder, to, log)).toBeUndefined();

        expect(rowsOf(to.state)).toEqual(['a', 'b']);
        expect(existsSync(to.cache)).toBe(false);
        expect(existsSync(join(folder, '.vscode'))).toBe(false);
        expect(existsSync(folder)).toBe(true);
        expect(logged).toEqual([
            `info removed the cache at ${join(old, 'cache.db')}; it's built at ${to.cache} now.`,
            `info moved the now-tree from ${join(old, 'state.db')} to ${to.state}.`,
        ]);
    });

    it('takes in rows only the -wal holds', () => {
        // A window killed before it closed leaves the -wal unmerged: closing would merge it, so
        // the three files are copied while the database is open.
        const writer = walDatabase(join(old, 'state.db'), ['a']);
        const snapshot = join(root, 'snapshot');
        mkdirSync(join(snapshot, '.vscode', 'tsk'), { recursive: true });
        for (const f of ['state.db', 'state.db-wal', 'state.db-shm'])
            copyFileSync(join(old, f), join(snapshot, '.vscode', 'tsk', f));
        writer.close();
        expect(rowsOfMainFileOnly(join(snapshot, '.vscode', 'tsk', 'state.db'))).toEqual([]);

        const to = { state: join(storage, 'state.db') };
        moveOldDefaults(snapshot, to, log);
        expect(rowsOf(to.state)).toEqual(['a']);
    });

    it('leaves the folders when something else is in them', () => {
        writeFileSync(join(old, 'tags.yml'), 'tags: []\n');
        walDatabase(join(old, 'cache.db'), []).close();
        moveOldDefaults(folder, { cache: join(storage, 'cache.db') }, log);
        expect(readdirSync(old)).toEqual(['tags.yml']);
    });

    it('acts only on the databases it is given: one whose setting is set stays', () => {
        walDatabase(join(old, 'cache.db'), []).close();
        walDatabase(join(old, 'state.db'), ['a']).close();
        moveOldDefaults(folder, { cache: join(storage, 'cache.db') }, log);
        expect(readdirSync(old).sort()).toEqual(['state.db']);
        expect(existsSync(join(storage, 'state.db'))).toBe(false);
    });

    it('leaves both now-trees when the new place has one already', () => {
        walDatabase(join(old, 'state.db'), ['old']).close();
        mkdirSync(storage, { recursive: true });
        walDatabase(join(storage, 'state.db'), ['new']).close();
        expect(moveOldDefaults(folder, { state: join(storage, 'state.db') }, log)).toBeUndefined();
        expect(rowsOf(join(old, 'state.db'))).toEqual(['old']);
        expect(rowsOf(join(storage, 'state.db'))).toEqual(['new']);
        expect(logged[0]).toMatch(/^warn a now-tree is at both /);
    });

    it('opens the old now-tree when it cannot be copied, and keeps it', () => {
        walDatabase(join(old, 'state.db'), ['a']).close();
        mkdirSync(storage, { recursive: true });
        chmodSync(storage, 0o500);
        try {
            const to = join(storage, 'state.db');
            expect(moveOldDefaults(folder, { state: to }, log)).toBe(join(old, 'state.db'));
            expect(rowsOf(join(old, 'state.db'))).toEqual(['a']);
            expect(existsSync(to)).toBe(false);
            expect(logged[0]).toMatch(/^warn couldn't move the now-tree from /);
        } finally {
            chmodSync(storage, 0o700);
        }
    });

    it('does nothing where the old defaults left nothing', () => {
        rmSync(join(folder, '.vscode'), { recursive: true });
        const to = { cache: join(storage, 'cache.db'), state: join(storage, 'state.db') };
        expect(moveOldDefaults(folder, to, log)).toBeUndefined();
        expect(existsSync(storage)).toBe(false);
        expect(logged).toEqual([]);
    });
});
