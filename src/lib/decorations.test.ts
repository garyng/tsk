import { describe, expect, it } from 'vitest';
import {
    computeMarkerRanges,
    computePriorityRanges,
    MARKER_STRIKETHROUGH,
    MARKER_THEME_COLOR_IDS,
    priorityBackgroundColor,
    type RangeLike,
} from './decorations';
import { MARKERS } from './markers';
import type { Task } from './parser';
import { PRIORITIES } from './priorities';

/**
 * Build a `Task` with only the fields decorations actually read; the rest
 * get harmless defaults so the type-checker stays happy. `metadata` etc.
 * can be overridden when a specific case needs them (priority tests).
 */
function task(fields: Pick<Task, 'marker' | 'raw' | 'line' | 'indent'> & Partial<Task>): Task {
    return {
        content: '',
        metadata: new Map<string, string | null>(),
        tags: [],
        ...fields,
    };
}

const ALL_MARKERS = MARKERS.map((m) => m.name);

function meta(entries: ReadonlyArray<[string, string | null]>): Map<string, string | null> {
    return new Map<string, string | null>(entries);
}

describe('MARKER_THEME_COLOR_IDS', () => {
    it('has an entry for every marker (the map is total)', () => {
        expect(Object.keys(MARKER_THEME_COLOR_IDS).sort()).toEqual([...ALL_MARKERS].sort());
    });

    it('leaves todo undefined so the editor default foreground wins', () => {
        expect(MARKER_THEME_COLOR_IDS.todo).toBeUndefined();
    });

    it('uses the tsk.marker.* namespace for the five overrides', () => {
        for (const marker of ['inprogress', 'completed', 'moved', 'cancelled', 'notes'] as const) {
            expect(MARKER_THEME_COLOR_IDS[marker]).toBe(`tsk.marker.${marker}`);
        }
    });
});

describe('MARKER_STRIKETHROUGH', () => {
    it('contains exactly completed and cancelled', () => {
        expect([...MARKER_STRIKETHROUGH].sort()).toEqual(['cancelled', 'completed']);
    });

    it('does not strike through moved (terminal but linked) or inprogress/notes/todo', () => {
        for (const marker of ['todo', 'inprogress', 'moved', 'notes'] as const) {
            expect(MARKER_STRIKETHROUGH.has(marker)).toBe(false);
        }
    });
});

describe('computeMarkerRanges', () => {
    it('returns an empty map when given no tasks', () => {
        expect(computeMarkerRanges([])).toEqual(new Map());
    });

    it('emits a 3-char range covering [X] on a flat dash task', () => {
        const tasks = [task({ marker: 'todo', raw: '- [ ] do it', line: 0, indent: '' })];
        expect(computeMarkerRanges(tasks).get('todo')).toEqual<RangeLike[]>([
            { startLine: 0, startCol: 2, endLine: 0, endCol: 5 },
        ]);
    });

    it('shifts the range right by indent length on an indented task', () => {
        const tasks = [
            task({ marker: 'completed', raw: '    - [x] done', line: 3, indent: '    ' }),
        ];
        expect(computeMarkerRanges(tasks).get('completed')).toEqual<RangeLike[]>([
            { startLine: 3, startCol: 6, endLine: 3, endCol: 9 },
        ]);
    });

    it('handles a deeply nested task with tab + spaces indent', () => {
        const tasks = [
            task({ marker: 'inprogress', raw: '\t  - [/] deep', line: 7, indent: '\t  ' }),
        ];
        expect(computeMarkerRanges(tasks).get('inprogress')).toEqual<RangeLike[]>([
            { startLine: 7, startCol: 5, endLine: 7, endCol: 8 },
        ]);
    });

    it('handles bullet chars other than dash (* and +)', () => {
        const tasks = [
            task({ marker: 'inprogress', raw: '* [/] starred', line: 1, indent: '' }),
            task({ marker: 'notes', raw: '+ [n] plused', line: 2, indent: '' }),
        ];
        const out = computeMarkerRanges(tasks);
        expect(out.get('inprogress')).toEqual<RangeLike[]>([
            { startLine: 1, startCol: 2, endLine: 1, endCol: 5 },
        ]);
        expect(out.get('notes')).toEqual<RangeLike[]>([
            { startLine: 2, startCol: 2, endLine: 2, endCol: 5 },
        ]);
    });

    it('tolerates extra whitespace between bullet and bracket', () => {
        const tasks = [task({ marker: 'todo', raw: '-   [ ] spaced', line: 0, indent: '' })];
        expect(computeMarkerRanges(tasks).get('todo')).toEqual<RangeLike[]>([
            { startLine: 0, startCol: 4, endLine: 0, endCol: 7 },
        ]);
    });

    it('locks onto the marker bracket even when content contains [', () => {
        const tasks = [task({ marker: 'todo', raw: '- [ ] read [the docs]', line: 0, indent: '' })];
        expect(computeMarkerRanges(tasks).get('todo')).toEqual<RangeLike[]>([
            { startLine: 0, startCol: 2, endLine: 0, endCol: 5 },
        ]);
    });

    it('buckets multiple tasks by marker, preserving input order per bucket', () => {
        const tasks = [
            task({ marker: 'todo', raw: '- [ ] a', line: 0, indent: '' }),
            task({ marker: 'completed', raw: '- [x] b', line: 1, indent: '' }),
            task({ marker: 'todo', raw: '- [ ] c', line: 2, indent: '' }),
        ];
        const out = computeMarkerRanges(tasks);
        expect(out.get('todo')?.map((r) => r.startLine)).toEqual([0, 2]);
        expect(out.get('completed')?.map((r) => r.startLine)).toEqual([1]);
    });

    it('omits markers with no tasks (sparse map, not a fully-populated one)', () => {
        const tasks = [task({ marker: 'todo', raw: '- [ ] only one', line: 0, indent: '' })];
        const out = computeMarkerRanges(tasks);
        expect([...out.keys()]).toEqual(['todo']);
    });
});

describe('priorityBackgroundColor', () => {
    it('formats rgba(...) for P1 (red)', () => {
        expect(priorityBackgroundColor(1, 0.15)).toBe('rgba(255, 99, 71, 0.15)');
    });

    it('formats rgba(...) for P2 (yellow)', () => {
        expect(priorityBackgroundColor(2, 0.5)).toBe('rgba(255, 200, 0, 0.5)');
    });

    it('formats rgba(...) for P3 (blue)', () => {
        expect(priorityBackgroundColor(3, 1)).toBe('rgba(100, 149, 237, 1)');
    });

    it('preserves zero opacity literally', () => {
        expect(priorityBackgroundColor(1, 0)).toBe('rgba(255, 99, 71, 0)');
    });

    it('agrees with the PRIORITIES registry for every legal level', () => {
        for (const def of PRIORITIES) {
            const [r, g, b] = def.rgb;
            expect(priorityBackgroundColor(def.level, 0.3)).toBe(`rgba(${r}, ${g}, ${b}, 0.3)`);
        }
    });
});

describe('computePriorityRanges', () => {
    it('returns an empty map when given no tasks', () => {
        expect(computePriorityRanges([])).toEqual(new Map());
    });

    it('emits a whole-line range for each legal @priority value', () => {
        const tasks = [
            task({
                marker: 'todo',
                raw: '- [ ] critical',
                line: 0,
                indent: '',
                metadata: meta([['priority', '1']]),
            }),
            task({
                marker: 'todo',
                raw: '- [ ] important',
                line: 1,
                indent: '',
                metadata: meta([['priority', '2']]),
            }),
            task({
                marker: 'todo',
                raw: '- [ ] nice-to-have',
                line: 2,
                indent: '',
                metadata: meta([['priority', '3']]),
            }),
        ];
        const out = computePriorityRanges(tasks);
        expect(out.get(1)).toEqual<RangeLike[]>([
            { startLine: 0, startCol: 0, endLine: 0, endCol: '- [ ] critical'.length },
        ]);
        expect(out.get(2)).toEqual<RangeLike[]>([
            { startLine: 1, startCol: 0, endLine: 1, endCol: '- [ ] important'.length },
        ]);
        expect(out.get(3)).toEqual<RangeLike[]>([
            { startLine: 2, startCol: 0, endLine: 2, endCol: '- [ ] nice-to-have'.length },
        ]);
    });

    it('drops tasks without @priority metadata', () => {
        const tasks = [task({ marker: 'todo', raw: '- [ ] plain', line: 0, indent: '' })];
        expect(computePriorityRanges(tasks)).toEqual(new Map());
    });

    it('drops flag-form @priority (value null)', () => {
        const tasks = [
            task({
                marker: 'todo',
                raw: '- [ ] flag',
                line: 0,
                indent: '',
                metadata: meta([['priority', null]]),
            }),
        ];
        expect(computePriorityRanges(tasks)).toEqual(new Map());
    });

    it('drops empty-valued @priority: (value "")', () => {
        const tasks = [
            task({
                marker: 'todo',
                raw: '- [ ] empty',
                line: 0,
                indent: '',
                metadata: meta([['priority', '']]),
            }),
        ];
        expect(computePriorityRanges(tasks)).toEqual(new Map());
    });

    it('drops out-of-range and non-numeric values (0, 4, high, 1.5, -1)', () => {
        const malformed = ['0', '4', 'high', '1.5', '-1', '01', ' 1', '1 '];
        const tasks = malformed.map((value, i) =>
            task({
                marker: 'todo',
                raw: `- [ ] bad ${value}`,
                line: i,
                indent: '',
                metadata: meta([['priority', value]]),
            }),
        );
        expect(computePriorityRanges(tasks)).toEqual(new Map());
    });

    it('buckets multiple tasks of the same priority', () => {
        const tasks = [
            task({
                marker: 'todo',
                raw: '- [ ] a',
                line: 0,
                indent: '',
                metadata: meta([['priority', '1']]),
            }),
            task({
                marker: 'todo',
                raw: '- [ ] b',
                line: 2,
                indent: '',
                metadata: meta([['priority', '1']]),
            }),
            task({
                marker: 'todo',
                raw: '- [ ] c',
                line: 5,
                indent: '',
                metadata: meta([['priority', '2']]),
            }),
        ];
        const out = computePriorityRanges(tasks);
        expect(out.get(1)?.map((r) => r.startLine)).toEqual([0, 2]);
        expect(out.get(2)?.map((r) => r.startLine)).toEqual([5]);
        expect(out.get(3)).toBeUndefined();
    });
});
