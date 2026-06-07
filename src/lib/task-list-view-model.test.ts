import { describe, expect, it } from 'vitest';
import type { Marker } from './markers';
import { buildTaskListView } from './task-list-view-model';

type TaskInput = { id: string; marker: Marker; content: string; fileUri: string; line: number };

describe('buildTaskListView', () => {
    it('maps each task to a flat row with a basename file (content kept verbatim)', () => {
        const view = buildTaskListView([
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
        ] satisfies TaskInput[]);
        expect(view.rows).toEqual([
            {
                id: 'a',
                marker: 'inprogress',
                content: 'refactor the cache #project/area',
                file: 'foo.tsk',
                line: 4,
            },
            { id: 'b', marker: 'todo', content: 'later', file: 'bar.tsk', line: 0 },
        ]);
        expect(view.total).toBe(2);
    });

    it('counts every marker in registry order, even at zero', () => {
        const view = buildTaskListView([
            { id: 'a', marker: 'todo', content: '', fileUri: 'file:///a.tsk', line: 0 },
            { id: 'b', marker: 'todo', content: '', fileUri: 'file:///a.tsk', line: 1 },
            { id: 'c', marker: 'completed', content: '', fileUri: 'file:///a.tsk', line: 2 },
        ] satisfies TaskInput[]);
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
        const view = buildTaskListView([
            { id: 'a', marker: 'todo', content: '', fileUri: 'file:///ws/my%20tasks.tsk', line: 0 },
        ] satisfies TaskInput[]);
        expect(view.rows[0]?.file).toBe('my tasks.tsk');
    });
});
