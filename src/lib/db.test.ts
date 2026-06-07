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
        const inserted = db.insertTask({
            id: 'abc12345',
            fileUri: 'file:///a.tsk',
            line: 3,
            marker: 'todo',
            content: 'do thing',
            raw: '- [ ] do thing <!-- @id:abc12345 -->',
        });
        expect(inserted).toBe(true);
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

    it('finds a unique task by id (PK lookup)', () => {
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

    it('ignores duplicate ids (first-occurrence wins) and reports insert=false', () => {
        db.upsertFile('file:///b.tsk', 100);
        const first = db.insertTask({
            id: 'x',
            fileUri: 'file:///a.tsk',
            line: 1,
            marker: 'todo',
            content: 'first',
            raw: '',
        });
        const second = db.insertTask({
            id: 'x',
            fileUri: 'file:///b.tsk',
            line: 9,
            marker: 'completed',
            content: 'second',
            raw: '',
        });
        expect(first).toBe(true);
        expect(second).toBe(false);
        // First-occurrence wins — the row from file A survives.
        const found = db.findTaskById('x');
        expect(found?.fileUri).toBe('file:///a.tsk');
        expect(found?.content).toBe('first');
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

    it('inserts and retrieves metadata for a task', () => {
        db.insertMetadata({ taskId: 'abc', key: 'created', value: '2026-01-02T12:45:30+08:00' });
        const list = db.listMetadataForTask('abc');
        expect(list).toHaveLength(1);
        expect(list[0]).toEqual({
            taskId: 'abc',
            key: 'created',
            value: '2026-01-02T12:45:30+08:00',
        });
    });

    it('preserves the null/empty-string distinction round-trip', () => {
        db.insertMetadata({ taskId: 'abc', key: 'flag', value: null });
        db.insertMetadata({ taskId: 'abc', key: 'empty', value: '' });
        const byKey = new Map(db.listMetadataForTask('abc').map((m) => [m.key, m.value]));
        expect(byKey.get('flag')).toBeNull();
        expect(byKey.get('empty')).toBe('');
    });

    it('lists every (taskId, key, value) row via listAllMetadata', () => {
        db.insertTask({
            id: 'def',
            fileUri: 'file:///a.tsk',
            line: 2,
            marker: 'todo',
            content: '',
            raw: '',
        });
        db.insertMetadata({ taskId: 'abc', key: 'created', value: '2026-01-02T12:45:30+08:00' });
        db.insertMetadata({ taskId: 'abc', key: 'started', value: '2026-01-03T09:00:00+08:00' });
        db.insertMetadata({ taskId: 'def', key: 'completed', value: '2026-01-04T18:00:00+08:00' });
        // Order isn't guaranteed by the query; compare as a sorted set.
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

    it('inserts and lists tags for a task', () => {
        db.insertTag({ taskId: 'a', tag: 'project/test' });
        db.insertTag({ taskId: 'a', tag: 'JIRAID-123' });
        expect(db.listTagsForTask('a').sort()).toEqual(['JIRAID-123', 'project/test']);
    });

    it('lists distinct tags across all tasks', () => {
        db.insertTag({ taskId: 'a', tag: 'x' });
        db.insertTag({ taskId: 'b', tag: 'x' });
        db.insertTag({ taskId: 'b', tag: 'y' });
        expect(db.listAllTags()).toEqual(['x', 'y']);
    });

    it('lists every (taskId, tag) pair via listAllTaskTags', () => {
        db.insertTag({ taskId: 'a', tag: 'x' });
        db.insertTag({ taskId: 'b', tag: 'x' });
        db.insertTag({ taskId: 'b', tag: 'y' });
        const pairs = db.listAllTaskTags();
        // Order isn't guaranteed by the query; compare as a sorted set.
        const sorted = pairs.map(([t, g]) => `${t}:${g}`).sort();
        expect(sorted).toEqual(['a:x', 'b:x', 'b:y']);
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
        db.insertMetadata({ taskId: 'abc', key: 'id', value: 'abc' });
        db.insertTag({ taskId: 'abc', tag: 'x' });

        db.deleteFile('file:///a.tsk');

        expect(db.findTaskById('abc')).toBeUndefined();
        expect(db.listMetadataForTask('abc')).toEqual([]);
        expect(db.listTagsForTask('abc')).toEqual([]);
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

    it('counts files, tasks, and distinct tags', () => {
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
        db.insertTag({ taskId: 'ta', tag: 'shared' });
        db.insertTag({ taskId: 'tb', tag: 'shared' });
        db.insertTag({ taskId: 'ta', tag: 'unique' });

        expect(db.counts()).toEqual({ files: 2, tasks: 2, tags: 2 });
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
