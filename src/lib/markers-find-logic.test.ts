import { describe, expect, it } from 'vitest';
import { MARKERS, type Marker } from './markers';
import {
    buildMarkerSearchArgs,
    countTasksByMarker,
    groupTasksByMarker,
    markersToPickItems,
} from './markers-find-logic';

describe('countTasksByMarker', () => {
    it('tallies tasks per marker (flat, no hierarchy)', () => {
        const counts = countTasksByMarker([
            { marker: 'todo' },
            { marker: 'inprogress' },
            { marker: 'todo' },
        ] satisfies { marker: Marker }[]);
        expect(counts.get('todo')).toBe(2);
        expect(counts.get('inprogress')).toBe(1);
        expect(counts.get('completed')).toBeUndefined();
    });

    it('is empty for no tasks', () => {
        expect(countTasksByMarker([]).size).toBe(0);
    });
});

describe('groupTasksByMarker', () => {
    it('groups tasks by marker in registry order, preserving task shape', () => {
        const tasks = [
            { id: 'a', marker: 'todo' },
            { id: 'b', marker: 'completed' },
            { id: 'c', marker: 'todo' },
        ] satisfies { id: string; marker: Marker }[];
        const groups = groupTasksByMarker(tasks);
        expect(groups.map((g) => g.marker)).toEqual([
            'todo',
            'inprogress',
            'completed',
            'moved',
            'cancelled',
            'notes',
        ]);
        const todo = groups.find((g) => g.marker === 'todo');
        expect(todo?.label).toBe('Todo');
        expect(todo?.tasks.map((t) => t.id)).toEqual(['a', 'c']);
        expect(groups.find((g) => g.marker === 'completed')?.tasks.map((t) => t.id)).toEqual(['b']);
    });

    it('lists every marker even with no tasks (empty groups)', () => {
        const groups = groupTasksByMarker([]);
        expect(groups).toHaveLength(MARKERS.length);
        expect(groups.every((g) => g.tasks.length === 0)).toBe(true);
    });
});

describe('markersToPickItems', () => {
    it('lists all six markers in registry order with glyph + count', () => {
        const items = markersToPickItems(new Map<Marker, number>([['inprogress', 3]]));
        expect(items.map((i) => i.marker)).toEqual([
            'todo',
            'inprogress',
            'completed',
            'moved',
            'cancelled',
            'notes',
        ]);
        const inprog = items.find((i) => i.marker === 'inprogress');
        expect(inprog?.label).toBe('In progress');
        expect(inprog?.description).toBe('[/]  ·  3 tasks');
        // zero-count markers stay listed; singular vs plural
        expect(items.find((i) => i.marker === 'todo')?.description).toBe('[ ]  ·  0 tasks');
        const one = markersToPickItems(new Map<Marker, number>([['todo', 1]]));
        expect(one.find((i) => i.marker === 'todo')?.description).toBe('[ ]  ·  1 task');
    });
});

describe('buildMarkerSearchArgs', () => {
    it('anchors the [glyph] triplet at line start as a regex', () => {
        const args = buildMarkerSearchArgs('inprogress');
        expect(args.isRegexp).toBe(true);
        expect(args.filesToInclude).toBe('*.tsk');
        expect(args.query).toBe('^\\s*[-*+] \\[/\\]');
    });

    it('anchors the space glyph (todo) so prose [ ] is not matched', () => {
        const args = buildMarkerSearchArgs('todo');
        expect(args.query).toBe('^\\s*[-*+] \\[ \\]');
        const re = new RegExp(args.query);
        expect(re.test('- [ ] write the spec')).toBe(true);
        expect(re.test('    * [ ] nested todo')).toBe(true);
        expect(re.test('see the checkbox [ ] in prose')).toBe(false);
        expect(re.test('- [/] in progress')).toBe(false);
    });

    it('matches its own glyph and not another marker’s', () => {
        const line = (g: string) => `- [${g}] task`;
        const cases: Array<[Marker, string]> = [
            ['todo', ' '],
            ['inprogress', '/'],
            ['completed', 'x'],
            ['moved', '>'],
            ['cancelled', '!'],
            ['notes', 'n'],
        ];
        for (const [marker, glyph] of cases) {
            const re = new RegExp(buildMarkerSearchArgs(marker).query);
            expect(re.test(line(glyph))).toBe(true);
            expect(re.test(line(glyph === '/' ? 'x' : '/'))).toBe(false);
        }
    });
});
