import { describe, expect, it } from 'vitest';
import type { Marker } from './markers';
import { isGeneratedIdShape, shownRefs, taskRefsIn } from './tsk-ref';

describe('taskRefsIn', () => {
    it('finds each tsk:<id> with the offsets of the whole token', () => {
        expect(taskRefsIn('see tsk:5tdnqp74, then tsk:m3task1.')).toEqual([
            { id: '5tdnqp74', start: 4, end: 16 },
            { id: 'm3task1', start: 23, end: 34 },
        ]);
    });

    it('needs a word boundary before tsk:', () => {
        expect(taskRefsIn('garyng.tsk/open notsk:5tdnqp74')).toEqual([]);
    });

    it('is empty for a line without one', () => {
        expect(taskRefsIn('')).toEqual([]);
        expect(taskRefsIn('tsk: nothing after the colon')).toEqual([]);
    });
});

describe('isGeneratedIdShape', () => {
    it('is true for the generator’s 8 characters of its alphabet', () => {
        expect(isGeneratedIdShape('5tdnqp74')).toBe(true);
        expect(isGeneratedIdShape('zzzzzzzz')).toBe(true);
    });

    it('is false for other lengths, and for characters the alphabet leaves out', () => {
        expect(isGeneratedIdShape('test')).toBe(false);
        expect(isGeneratedIdShape('typecheck')).toBe(false);
        expect(isGeneratedIdShape('checkout')).toBe(false); // o
        expect(isGeneratedIdShape('5TDNQP74')).toBe(false);
        expect(isGeneratedIdShape('a-b_c2d3')).toBe(false);
    });
});

describe('shownRefs', () => {
    const known: Record<string, Marker> = { m3task1: 'todo', '5tdnqp74': 'inprogress' };
    const markerOf = (id: string) => known[id];

    it('shows each ref the workspace knows, with its marker, whatever its shape', () => {
        expect(shownRefs('tsk:m3task1 and tsk:5tdnqp74', markerOf)).toEqual([
            { id: 'm3task1', start: 0, end: 11, marker: 'todo' },
            { id: '5tdnqp74', start: 16, end: 28, marker: 'inprogress' },
        ]);
    });

    it('shows an unknown ref shaped like a generated id, without a marker', () => {
        expect(shownRefs('tsk:zzzzzzzz', markerOf)).toEqual([
            { id: 'zzzzzzzz', start: 0, end: 12, marker: undefined },
        ]);
    });

    it('leaves out an unknown ref of another shape, as `task tsk:test` in prose', () => {
        expect(shownRefs('run task tsk:test, then task tsk:typecheck', markerOf)).toEqual([]);
    });
});
