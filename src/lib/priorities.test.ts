import { describe, expect, it } from 'vitest';
import { PRIORITIES, priorityForLevel } from './priorities';

describe('PRIORITIES', () => {
    it('declares exactly levels 1, 2, 3 in order', () => {
        expect(PRIORITIES.map((p) => p.level)).toEqual([1, 2, 3]);
    });

    it('every level has a 3-tuple RGB and a non-empty label', () => {
        for (const def of PRIORITIES) {
            expect(def.rgb).toHaveLength(3);
            for (const channel of def.rgb) {
                expect(channel).toBeGreaterThanOrEqual(0);
                expect(channel).toBeLessThanOrEqual(255);
            }
            expect(def.label.length).toBeGreaterThan(0);
        }
    });
});

describe('priorityForLevel', () => {
    it('returns the matching definition for legal levels', () => {
        for (const def of PRIORITIES) {
            expect(priorityForLevel(def.level)).toBe(def);
        }
    });

    it('returns undefined for out-of-range levels', () => {
        expect(priorityForLevel(0)).toBeUndefined();
        expect(priorityForLevel(4)).toBeUndefined();
        expect(priorityForLevel(-1)).toBeUndefined();
        expect(priorityForLevel(1.5)).toBeUndefined();
    });
});
