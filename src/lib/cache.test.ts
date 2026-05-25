import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheService } from './cache';
import { Db } from './db';

let db: Db;
let cache: CacheService;

beforeEach(() => {
    db = new Db(':memory:');
    cache = new CacheService(db);
});

afterEach(() => {
    db.close();
});

const URI_A = 'file:///workspace/a.tsk';
const URI_B = 'file:///workspace/b.tsk';

describe('CacheService — rescanFile happy path', () => {
    it('inserts a single task with @id', () => {
        const result = cache.rescanFile(URI_A, '- [ ] do thing <!-- @id:abc12345 -->', 100);
        expect(result).toEqual({ inserted: 1, skipped: 0, warnings: [] });
        const task = cache.lookupById('abc12345');
        expect(task?.fileUri).toBe(URI_A);
        expect(task?.line).toBe(0);
        expect(task?.marker).toBe('todo');
    });

    it('stores metadata for the inserted task', () => {
        cache.rescanFile(
            URI_A,
            '- [x] done <!-- @id:abc @created:2026-01-02T12:45:30+08:00 -->',
            100,
        );
        const metadata = db.listMetadataForTask('abc');
        const byKey = new Map(metadata.map((m) => [m.key, m.value]));
        expect(byKey.get('id')).toBe('abc');
        expect(byKey.get('created')).toBe('2026-01-02T12:45:30+08:00');
    });

    it('stores tags for the inserted task', () => {
        cache.rescanFile(URI_A, '- [ ] do #project/test #JIRAID-123 <!-- @id:tagged -->', 100);
        expect(db.listTagsForTask('tagged').sort()).toEqual(['JIRAID-123', 'project/test']);
    });

    it('inserts multiple tasks from one document', () => {
        const text = [
            '- [ ] first <!-- @id:t1 -->',
            '- [x] second <!-- @id:t2 -->',
            '- [/] third <!-- @id:t3 -->',
        ].join('\n');
        const result = cache.rescanFile(URI_A, text, 100);
        expect(result.inserted).toBe(3);
        expect(result.skipped).toBe(0);
        expect(result.warnings).toEqual([]);
    });

    it('ignores non-task lines', () => {
        const text = [
            '# heading',
            '',
            'plain prose here',
            '- [ ] one task <!-- @id:only -->',
            'more prose',
        ].join('\n');
        const result = cache.rescanFile(URI_A, text, 100);
        expect(result.inserted).toBe(1);
        expect(cache.lookupById('only')?.line).toBe(3);
    });

    it('records the original raw line in TaskRecord.raw', () => {
        const line = '- [/] keep me as-is <!-- @id:raw01 -->';
        cache.rescanFile(URI_A, line, 100);
        expect(cache.lookupById('raw01')?.raw).toBe(line);
    });
});

describe('CacheService — rescanFile warnings', () => {
    it('warns and skips a task without an @id', () => {
        const result = cache.rescanFile(URI_A, '- [ ] anonymous', 100);
        expect(result.inserted).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.warnings).toHaveLength(1);
        const w = result.warnings[0];
        expect(w?.kind).toBe('no-id');
        expect(w?.fileUri).toBe(URI_A);
        expect(w?.line).toBe(0);
        expect(w?.columnEnd).toBe('- [ ] anonymous'.length);
        expect(w?.message).toMatch(/Task has no @id/);
    });

    it('warns and skips a task whose @id collides with one already cached (cross-file)', () => {
        cache.rescanFile(URI_A, '- [x] first <!-- @id:dup -->', 100);
        const result = cache.rescanFile(URI_B, '- [ ] second <!-- @id:dup -->', 100);

        expect(result.inserted).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.warnings).toHaveLength(1);
        const w = result.warnings[0];
        expect(w?.kind).toBe('duplicate-id');
        expect(w?.id).toBe('dup');
        expect(w?.fileUri).toBe(URI_B);
        expect(w?.firstOccurrence).toEqual({ fileUri: URI_A, line: 0 });
        expect(w?.message).toContain('first occurrence at');
        expect(w?.message).toContain(URI_A);

        // The first-occurrence task survives unchanged.
        expect(cache.lookupById('dup')?.fileUri).toBe(URI_A);
        expect(cache.lookupById('dup')?.content).toBe('first');
    });

    it('warns and skips an in-file duplicate @id (second wins lookup loses)', () => {
        const text = ['- [ ] first <!-- @id:dup -->', '- [x] second <!-- @id:dup -->'].join('\n');
        const result = cache.rescanFile(URI_A, text, 100);
        expect(result.inserted).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]?.kind).toBe('duplicate-id');
        expect(cache.lookupById('dup')?.line).toBe(0);
        expect(cache.lookupById('dup')?.content).toBe('first');
    });

    it('mixes warnings and successful inserts in the same scan', () => {
        const text = [
            '- [ ] good one <!-- @id:keep -->',
            '- [ ] anon',
            '- [x] another <!-- @id:keep -->',
        ].join('\n');
        const result = cache.rescanFile(URI_A, text, 100);
        expect(result.inserted).toBe(1);
        expect(result.skipped).toBe(2);
        const kinds = result.warnings.map((w) => w.kind).sort();
        expect(kinds).toEqual(['duplicate-id', 'no-id']);
    });
});

describe('CacheService — rescan idempotency', () => {
    it('rescanning the same content twice yields the same state', () => {
        const text = '- [ ] task <!-- @id:t1 -->';
        const r1 = cache.rescanFile(URI_A, text, 100);
        const r2 = cache.rescanFile(URI_A, text, 100);
        expect(r2).toEqual(r1);
        expect(cache.counts()).toEqual({ files: 1, tasks: 1, tags: 0 });
    });

    it('rescanning with new content replaces the old tasks', () => {
        cache.rescanFile(URI_A, '- [ ] old <!-- @id:old -->', 100);
        cache.rescanFile(URI_A, '- [ ] new <!-- @id:new -->', 200);

        expect(cache.lookupById('old')).toBeUndefined();
        expect(cache.lookupById('new')?.content).toBe('new');
        expect(db.getFile(URI_A)?.mtime).toBe(200);
    });

    it('cascades deletion of metadata and tags when rescanning', () => {
        cache.rescanFile(URI_A, '- [ ] old #project/old <!-- @id:old @custom:val -->', 100);
        cache.rescanFile(URI_A, '- [ ] new <!-- @id:new -->', 200);
        expect(db.listMetadataForTask('old')).toEqual([]);
        expect(db.listTagsForTask('old')).toEqual([]);
        expect(cache.listAllTags()).toEqual([]);
    });
});

describe('CacheService — removeFile', () => {
    it('removes a file and cascades its tasks/metadata/tags', () => {
        cache.rescanFile(URI_A, '- [ ] task #t <!-- @id:abc -->', 100);
        cache.removeFile(URI_A);
        expect(cache.lookupById('abc')).toBeUndefined();
        expect(cache.listAllTags()).toEqual([]);
        expect(db.getFile(URI_A)).toBeUndefined();
    });

    it('is a no-op for a file that was never cached', () => {
        expect(() => cache.removeFile('file:///nope.tsk')).not.toThrow();
    });
});

describe('CacheService — purge', () => {
    it('clears all files, tasks, and tags', () => {
        cache.rescanFile(URI_A, '- [ ] a #x <!-- @id:a -->', 1);
        cache.rescanFile(URI_B, '- [ ] b #y <!-- @id:b -->', 1);
        cache.purge();
        expect(cache.counts()).toEqual({ files: 0, tasks: 0, tags: 0 });
        expect(cache.lookupById('a')).toBeUndefined();
        expect(cache.listAllTags()).toEqual([]);
    });
});

describe('CacheService — read helpers', () => {
    beforeEach(() => {
        cache.rescanFile(
            URI_A,
            '- [ ] a #shared <!-- @id:a -->\n- [ ] b #shared #only-b <!-- @id:b -->',
            100,
        );
        cache.rescanFile(URI_B, '- [ ] c #only-c <!-- @id:c -->', 100);
    });

    it('lookupById finds tasks across files', () => {
        expect(cache.lookupById('a')?.fileUri).toBe(URI_A);
        expect(cache.lookupById('c')?.fileUri).toBe(URI_B);
        expect(cache.lookupById('missing')).toBeUndefined();
    });

    it('listAllTags returns sorted distinct tags', () => {
        expect(cache.listAllTags()).toEqual(['only-b', 'only-c', 'shared']);
    });

    it('counts reports files / tasks / distinct tags', () => {
        expect(cache.counts()).toEqual({ files: 2, tasks: 3, tags: 3 });
    });
});

describe('CacheService — transaction safety', () => {
    it('rolls back the whole rescan if the Db throws mid-scan', () => {
        cache.rescanFile(URI_A, '- [ ] original <!-- @id:keep -->', 100);

        const originalInsertTask = db.insertTask.bind(db);
        let callCount = 0;
        db.insertTask = (record) => {
            callCount++;
            if (callCount === 2) throw new Error('simulated db error');
            return originalInsertTask(record);
        };

        expect(() =>
            cache.rescanFile(
                URI_A,
                '- [ ] first <!-- @id:first -->\n- [ ] second <!-- @id:second -->',
                200,
            ),
        ).toThrow('simulated db error');

        // The rollback should restore the pre-scan state.
        expect(cache.lookupById('keep')?.content).toBe('original');
        expect(cache.lookupById('first')).toBeUndefined();
        expect(cache.lookupById('second')).toBeUndefined();
        expect(db.getFile(URI_A)?.mtime).toBe(100);
    });
});
