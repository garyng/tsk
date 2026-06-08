import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Db } from './db';

let db: Db;

beforeEach(() => {
    db = new Db(':memory:');
});

afterEach(() => {
    db.close();
});

describe('Db — files', () => {
    it('upserts a file and reads it back', () => {
        db.upsertFile('file:///a.tsk', 100);
        expect(db.getFile('file:///a.tsk')).toEqual({ uri: 'file:///a.tsk', mtime: 100 });
    });

    it('upserts an existing file (updates mtime)', () => {
        db.upsertFile('file:///a.tsk', 100);
        db.upsertFile('file:///a.tsk', 200);
        expect(db.getFile('file:///a.tsk')?.mtime).toBe(200);
    });

    it('returns undefined for a missing file', () => {
        expect(db.getFile('file:///missing.tsk')).toBeUndefined();
    });

    it('lists files ordered by uri', () => {
        db.upsertFile('file:///b.tsk', 2);
        db.upsertFile('file:///a.tsk', 1);
        expect(db.listFiles().map((f) => f.uri)).toEqual(['file:///a.tsk', 'file:///b.tsk']);
    });

    it('deletes a file', () => {
        db.upsertFile('file:///a.tsk', 1);
        db.deleteFile('file:///a.tsk');
        expect(db.getFile('file:///a.tsk')).toBeUndefined();
    });
});

describe('Db — tasks', () => {
    beforeEach(() => {
        db.upsertFile('file:///a.tsk', 100);
    });

    it('inserts a task and lists it by file', () => {
        db.insertTask({
            id: 'abc12345',
            fileUri: 'file:///a.tsk',
            line: 3,
            marker: 'todo',
            content: 'do thing',
            raw: '- [ ] do thing <!-- @id:abc12345 -->',
        });
        const tasks = db.listTasksForFile('file:///a.tsk');
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toEqual({
            id: 'abc12345',
            fileUri: 'file:///a.tsk',
            line: 3,
            marker: 'todo',
            content: 'do thing',
            raw: '- [ ] do thing <!-- @id:abc12345 -->',
        });
    });

    it('orders tasks by line within a file', () => {
        for (const [id, line] of [
            ['c', 5],
            ['a', 2],
            ['b', 8],
        ] as const) {
            db.insertTask({
                id,
                fileUri: 'file:///a.tsk',
                line,
                marker: 'todo',
                content: '',
                raw: '',
            });
        }
        expect(db.listTasksForFile('file:///a.tsk').map((t) => t.id)).toEqual(['a', 'c', 'b']);
    });

    it('finds a unique task by id', () => {
        db.insertTask({
            id: 'unique',
            fileUri: 'file:///a.tsk',
            line: 1,
            marker: 'todo',
            content: '',
            raw: '',
        });
        const found = db.findTaskById('unique');
        expect(found?.line).toBe(1);
    });

    it('returns undefined for a missing id', () => {
        expect(db.findTaskById('missing')).toBeUndefined();
    });

    it('stores every occurrence of a duplicate @id; findTaskById returns the lex-lowest', () => {
        db.upsertFile('file:///b.tsk', 100);
        // Insert the higher-sorting occurrence first to prove the winner is by
        // (file_uri, line), not scan order.
        db.insertTask({
            id: 'x',
            fileUri: 'file:///b.tsk',
            line: 9,
            marker: 'completed',
            content: 'second',
            raw: '',
        });
        db.insertTask({
            id: 'x',
            fileUri: 'file:///a.tsk',
            line: 1,
            marker: 'todo',
            content: 'first',
            raw: '',
        });
        // Both occurrences are stored…
        expect(db.listTasksForFile('file:///a.tsk')).toHaveLength(1);
        expect(db.listTasksForFile('file:///b.tsk')).toHaveLength(1);
        // …and findTaskById resolves the lex-lowest (file a, line 1).
        const found = db.findTaskById('x');
        expect(found?.fileUri).toBe('file:///a.tsk');
        expect(found?.content).toBe('first');
        // The picker view (canonical-only) lists the id once.
        expect(db.listAllTasks().filter((t) => t.id === 'x')).toHaveLength(1);
    });

    it('re-promotes the surviving occurrence when the winner file is deleted', () => {
        db.upsertFile('file:///b.tsk', 100);
        db.insertTask({
            id: 'x',
            fileUri: 'file:///a.tsk',
            line: 1,
            marker: 'todo',
            content: 'winner',
            raw: '',
        });
        db.insertTask({
            id: 'x',
            fileUri: 'file:///b.tsk',
            line: 9,
            marker: 'completed',
            content: 'survivor',
            raw: '',
        });
        expect(db.findTaskById('x')?.fileUri).toBe('file:///a.tsk');

        db.deleteFile('file:///a.tsk');

        // The survivor in file b is promoted automatically — no reconcile step.
        const found = db.findTaskById('x');
        expect(found?.fileUri).toBe('file:///b.tsk');
        expect(found?.content).toBe('survivor');
    });
});

describe('Db — metadata', () => {
    beforeEach(() => {
        db.upsertFile('file:///a.tsk', 100);
        db.insertTask({
            id: 'abc',
            fileUri: 'file:///a.tsk',
            line: 1,
            marker: 'todo',
            content: '',
            raw: '',
        });
    });

    it('inserts and retrieves metadata for an occurrence', () => {
        db.insertMetadata('file:///a.tsk', 1, 'created', '2026-01-02T12:45:30+08:00');
        const list = db.listMetadataForOccurrence('file:///a.tsk', 1);
        expect(list).toEqual([{ key: 'created', value: '2026-01-02T12:45:30+08:00' }]);
    });

    it('preserves the null/empty-string distinction round-trip', () => {
        db.insertMetadata('file:///a.tsk', 1, 'flag', null);
        db.insertMetadata('file:///a.tsk', 1, 'empty', '');
        const byKey = new Map(
            db.listMetadataForOccurrence('file:///a.tsk', 1).map((m) => [m.key, m.value]),
        );
        expect(byKey.get('flag')).toBeNull();
        expect(byKey.get('empty')).toBe('');
    });

    it('lists canonical (taskId, key, value) rows via listAllMetadata', () => {
        db.insertTask({
            id: 'def',
            fileUri: 'file:///a.tsk',
            line: 2,
            marker: 'todo',
            content: '',
            raw: '',
        });
        db.insertMetadata('file:///a.tsk', 1, 'created', '2026-01-02T12:45:30+08:00');
        db.insertMetadata('file:///a.tsk', 1, 'started', '2026-01-03T09:00:00+08:00');
        db.insertMetadata('file:///a.tsk', 2, 'completed', '2026-01-04T18:00:00+08:00');
        const sorted = db
            .listAllMetadata()
            .map((m) => `${m.taskId}:${m.key}=${m.value}`)
            .sort();
        expect(sorted).toEqual([
            'abc:created=2026-01-02T12:45:30+08:00',
            'abc:started=2026-01-03T09:00:00+08:00',
            'def:completed=2026-01-04T18:00:00+08:00',
        ]);
    });

    it('listAllMetadata reports only the canonical occurrence of a duplicate id', () => {
        db.upsertFile('file:///b.tsk', 100);
        // Two occurrences of id 'abc' — the canonical is file a (already inserted).
        db.insertTask({
            id: 'abc',
            fileUri: 'file:///b.tsk',
            line: 5,
            marker: 'todo',
            content: '',
            raw: '',
        });
        db.insertMetadata('file:///a.tsk', 1, 'created', 'CANON');
        db.insertMetadata('file:///b.tsk', 5, 'created', 'DUP');
        const created = db
            .listAllMetadata()
            .filter((m) => m.taskId === 'abc' && m.key === 'created');
        expect(created).toEqual([{ taskId: 'abc', key: 'created', value: 'CANON' }]);
    });
});

describe('Db — tags', () => {
    beforeEach(() => {
        db.upsertFile('file:///a.tsk', 100);
        db.insertTask({
            id: 'a',
            fileUri: 'file:///a.tsk',
            line: 1,
            marker: 'todo',
            content: '',
            raw: '',
        });
        db.insertTask({
            id: 'b',
            fileUri: 'file:///a.tsk',
            line: 2,
            marker: 'todo',
            content: '',
            raw: '',
        });
    });

    it('lists distinct tags across all occurrences', () => {
        db.insertTag('file:///a.tsk', 1, 'x');
        db.insertTag('file:///a.tsk', 2, 'x');
        db.insertTag('file:///a.tsk', 2, 'y');
        expect(db.listAllTags()).toEqual(['x', 'y']);
    });

    it('lists canonical (taskId, tag) pairs via listAllTaskTags', () => {
        db.insertTag('file:///a.tsk', 1, 'x');
        db.insertTag('file:///a.tsk', 2, 'x');
        db.insertTag('file:///a.tsk', 2, 'y');
        const sorted = db
            .listAllTaskTags()
            .map(([t, g]) => `${t}:${g}`)
            .sort();
        expect(sorted).toEqual(['a:x', 'b:x', 'b:y']);
    });

    it('listAllTaskTags reports only the canonical occurrence of a duplicate id', () => {
        db.upsertFile('file:///b.tsk', 100);
        db.insertTask({
            id: 'a',
            fileUri: 'file:///b.tsk',
            line: 7,
            marker: 'todo',
            content: '',
            raw: '',
        });
        db.insertTag('file:///a.tsk', 1, 'canon'); // canonical occurrence of 'a'
        db.insertTag('file:///b.tsk', 7, 'dup'); // non-canonical occurrence of 'a'
        const tagsForA = db
            .listAllTaskTags()
            .filter(([t]) => t === 'a')
            .map(([, g]) => g);
        expect(tagsForA).toEqual(['canon']);
    });
});

describe('Db — tag_defs', () => {
    it('upserts and reads a tag def', () => {
        db.upsertTagDef('project/test', 'project test tag', 'project');
        expect(db.getTagDef('project/test')).toEqual({
            tag: 'project/test',
            description: 'project test tag',
            parent: 'project',
        });
    });

    it('preserves null description and parent', () => {
        db.upsertTagDef('plain', null, null);
        expect(db.getTagDef('plain')).toEqual({
            tag: 'plain',
            description: null,
            parent: null,
        });
    });

    it('updates an existing tag def on conflict', () => {
        db.upsertTagDef('x', 'first', null);
        db.upsertTagDef('x', 'second', 'parent');
        expect(db.getTagDef('x')).toEqual({
            tag: 'x',
            description: 'second',
            parent: 'parent',
        });
    });

    it('is cleared by purge() — pinned behavior', () => {
        db.upsertTagDef('x', 'd', null);
        db.purge();
        expect(db.getTagDef('x')).toBeUndefined();
    });
});

describe('Db — cascade delete', () => {
    it('deleting a file cascades to tasks, metadata, and tags', () => {
        db.upsertFile('file:///a.tsk', 100);
        db.insertTask({
            id: 'abc',
            fileUri: 'file:///a.tsk',
            line: 1,
            marker: 'todo',
            content: '',
            raw: '',
        });
        db.insertMetadata('file:///a.tsk', 1, 'id', 'abc');
        db.insertTag('file:///a.tsk', 1, 'x');

        db.deleteFile('file:///a.tsk');

        expect(db.findTaskById('abc')).toBeUndefined();
        expect(db.listMetadataForOccurrence('file:///a.tsk', 1)).toEqual([]);
        expect(db.listAllTaskTags()).toEqual([]);
        expect(db.listAllTags()).toEqual([]);
    });
});

describe('Db — transactions', () => {
    it('commits a successful transaction', () => {
        db.transaction(() => {
            db.upsertFile('file:///a.tsk', 1);
            db.upsertFile('file:///b.tsk', 1);
        });
        expect(db.listFiles()).toHaveLength(2);
    });

    it('rolls back a failed transaction', () => {
        expect(() =>
            db.transaction(() => {
                db.upsertFile('file:///a.tsk', 1);
                throw new Error('boom');
            }),
        ).toThrow('boom');
        expect(db.listFiles()).toEqual([]);
    });

    it('propagates the return value', () => {
        const result = db.transaction(() => {
            db.upsertFile('file:///a.tsk', 1);
            return 42;
        });
        expect(result).toBe(42);
    });
});

describe('Db — counts', () => {
    it('reports zero on a fresh DB', () => {
        expect(db.counts()).toEqual({ files: 0, tasks: 0, tags: 0 });
    });

    it('counts files, distinct task ids, and distinct tags', () => {
        db.upsertFile('file:///a.tsk', 100);
        db.upsertFile('file:///b.tsk', 100);
        db.insertTask({
            id: 'ta',
            fileUri: 'file:///a.tsk',
            line: 1,
            marker: 'todo',
            content: '',
            raw: '',
        });
        db.insertTask({
            id: 'tb',
            fileUri: 'file:///b.tsk',
            line: 1,
            marker: 'todo',
            content: '',
            raw: '',
        });
        db.insertTag('file:///a.tsk', 1, 'shared');
        db.insertTag('file:///b.tsk', 1, 'shared');
        db.insertTag('file:///a.tsk', 1, 'unique');

        expect(db.counts()).toEqual({ files: 2, tasks: 2, tags: 2 });
    });

    it('counts a duplicate @id once (COUNT DISTINCT id)', () => {
        db.upsertFile('file:///a.tsk', 100);
        db.upsertFile('file:///b.tsk', 100);
        db.insertTask({
            id: 'dup',
            fileUri: 'file:///a.tsk',
            line: 1,
            marker: 'todo',
            content: '',
            raw: '',
        });
        db.insertTask({
            id: 'dup',
            fileUri: 'file:///b.tsk',
            line: 1,
            marker: 'todo',
            content: '',
            raw: '',
        });
        expect(db.counts().tasks).toBe(1);
    });
});

describe('Db — file-backed', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), 'tsk-db-test-'));
    });

    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('opens a real file, writes, closes, reopens, reads', () => {
        const path = join(tmp, 'cache.db');
        let d = new Db(path);
        d.upsertFile('file:///a.tsk', 42);
        d.close();

        d = new Db(path);
        expect(d.getFile('file:///a.tsk')).toEqual({ uri: 'file:///a.tsk', mtime: 42 });
        d.close();
    });
});
