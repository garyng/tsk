import { describe, expect, it } from 'vitest';
import type { Marker } from './markers';
import { type ActiveFile, buildTaskListView, pickActiveFile } from './task-list-view-model';

type TaskInput = { id: string; marker: Marker; content: string; fileUri: string; line: number };

/** No side-table rows — for the cases that only exercise the task→row mapping. */
const NO_TAGS: ReadonlyArray<readonly [string, string]> = [];
const NO_META: ReadonlyArray<{ taskId: string; key: string; value: string | null }> = [];

describe('buildTaskListView', () => {
    it('maps each task to a flat row with a basename file (content kept verbatim)', () => {
        const view = buildTaskListView(
            [
                {
                    id: 'a',
                    marker: 'inprogress',
                    content: 'refactor the cache #project/area',
                    fileUri: 'file:///ws/foo.tsk',
                    line: 4,
                },
                {
                    id: 'b',
                    marker: 'todo',
                    content: 'later',
                    fileUri: 'file:///ws/sub/bar.tsk',
                    line: 0,
                },
            ] satisfies TaskInput[],
            NO_TAGS,
            NO_META,
        );
        expect(view.rows).toEqual([
            {
                id: 'a',
                marker: 'inprogress',
                content: 'refactor the cache #project/area',
                file: 'foo.tsk',
                fileUri: 'file:///ws/foo.tsk',
                line: 4,
                tags: [],
            },
            {
                id: 'b',
                marker: 'todo',
                content: 'later',
                file: 'bar.tsk',
                fileUri: 'file:///ws/sub/bar.tsk',
                line: 0,
                tags: [],
            },
        ]);
        expect(view.total).toBe(2);
    });

    it('keeps the full fileUri on each row (the filter key) distinct from the basename', () => {
        const view = buildTaskListView(
            [
                {
                    id: 'a',
                    marker: 'todo',
                    content: '',
                    fileUri: 'file:///ws/sub/bar.tsk',
                    line: 0,
                },
            ] satisfies TaskInput[],
            NO_TAGS,
            NO_META,
        );
        expect(view.rows[0]?.fileUri).toBe('file:///ws/sub/bar.tsk');
        expect(view.rows[0]?.file).toBe('bar.tsk');
    });

    it('counts every marker in registry order, even at zero', () => {
        const view = buildTaskListView(
            [
                { id: 'a', marker: 'todo', content: '', fileUri: 'file:///a.tsk', line: 0 },
                { id: 'b', marker: 'todo', content: '', fileUri: 'file:///a.tsk', line: 1 },
                { id: 'c', marker: 'completed', content: '', fileUri: 'file:///a.tsk', line: 2 },
            ] satisfies TaskInput[],
            NO_TAGS,
            NO_META,
        );
        expect(view.counts.map((c) => [c.marker, c.count])).toEqual([
            ['todo', 2],
            ['inprogress', 0],
            ['completed', 1],
            ['moved', 0],
            ['cancelled', 0],
            ['notes', 0],
        ]);
        expect(view.counts.find((c) => c.marker === 'todo')?.label).toBe('Todo');
    });

    it('percent-decodes the basename', () => {
        const view = buildTaskListView(
            [
                {
                    id: 'a',
                    marker: 'todo',
                    content: '',
                    fileUri: 'file:///ws/my%20tasks.tsk',
                    line: 0,
                },
            ],
            NO_TAGS,
            NO_META,
        );
        expect(view.rows[0]?.file).toBe('my tasks.tsk');
    });

    it('joins sorted #tags and the @created stamp onto each row', () => {
        const view = buildTaskListView(
            [
                { id: 'a', marker: 'inprogress', content: 'x', fileUri: 'file:///a.tsk', line: 0 },
                { id: 'b', marker: 'todo', content: 'y', fileUri: 'file:///a.tsk', line: 1 },
            ] satisfies TaskInput[],
            [
                ['a', 'zeta'],
                ['a', 'alpha'], // out of order → row.tags comes back sorted
            ],
            [
                { taskId: 'a', key: 'created', value: '2026-06-01T10:00:00+08:00' },
                { taskId: 'a', key: 'completed', value: '2026-06-02T10:00:00+08:00' }, // not 'created'
                { taskId: 'a', key: 'priority', value: '2' },
                { taskId: 'b', key: 'started', value: '2026-06-01T10:00:00+08:00' }, // b has no created
                { taskId: 'b', key: 'priority', value: '9' }, // out of range → dropped
            ],
        );
        const [a, b] = view.rows;
        expect(a?.tags).toEqual(['alpha', 'zeta']);
        expect(a?.created).toBe('2026-06-01T10:00:00+08:00');
        expect(a?.priority).toBe(2);
        expect(b?.tags).toEqual([]);
        expect(b?.created).toBeUndefined();
        expect(b?.priority).toBeUndefined(); // '9' is not 1–3
    });
});

describe('pickActiveFile (last-tsk-wins)', () => {
    const PREV: ActiveFile = { uri: 'file:///ws/old.tsk', name: 'old.tsk' };

    it('a .tsk candidate becomes the target, basename derived', () => {
        expect(pickActiveFile(PREV, { uri: 'file:///ws/new.tsk', isTsk: true })).toEqual({
            uri: 'file:///ws/new.tsk',
            name: 'new.tsk',
        });
    });

    it('a non-tsk candidate leaves the prior target in place', () => {
        expect(pickActiveFile(PREV, { uri: 'file:///ws/notes.md', isTsk: false })).toBe(PREV);
    });

    it('no candidate (focus left all editors / the panel) leaves the prior target', () => {
        expect(pickActiveFile(PREV, undefined)).toBe(PREV);
    });

    it('starts empty and stays empty until a .tsk file is active', () => {
        expect(pickActiveFile(undefined, undefined)).toBeUndefined();
        expect(pickActiveFile(undefined, { uri: 'file:///ws/x.md', isTsk: false })).toBeUndefined();
        expect(pickActiveFile(undefined, { uri: 'file:///ws/x.tsk', isTsk: true })).toEqual({
            uri: 'file:///ws/x.tsk',
            name: 'x.tsk',
        });
    });
});
