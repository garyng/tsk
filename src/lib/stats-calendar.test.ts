import { describe, expect, it } from 'vitest';
import { toCalendarData } from './stats-calendar';

const RANGE = { from: '2026-01-01', to: '2026-12-31' };

describe('toCalendarData', () => {
    it('scales levels to the busiest day and brackets the range', () => {
        const data = toCalendarData(
            [
                { date: '2026-05-10', count: 1 },
                { date: '2026-05-12', count: 4 },
                { date: '2026-05-15', count: 2 },
            ],
            RANGE,
        );
        expect(data).toEqual([
            { date: '2026-01-01', count: 0, level: 0 }, // from endpoint
            { date: '2026-05-10', count: 1, level: 1 }, // 1/4 → 1
            { date: '2026-05-12', count: 4, level: 4 }, // busiest → maxLevel
            { date: '2026-05-15', count: 2, level: 2 }, // 2/4 → 2
            { date: '2026-12-31', count: 0, level: 0 }, // to endpoint
        ]);
    });

    it('drops days outside the range', () => {
        const data = toCalendarData(
            [
                { date: '2025-12-31', count: 9 }, // before `from`
                { date: '2027-01-01', count: 9 }, // after `to`
                { date: '2026-06-01', count: 3 },
            ],
            RANGE,
        );
        expect(data.map((d) => d.date)).toEqual(['2026-01-01', '2026-06-01', '2026-12-31']);
    });

    it('returns just the two endpoints when there are no in-range events', () => {
        expect(toCalendarData([], RANGE)).toEqual([
            { date: '2026-01-01', count: 0, level: 0 },
            { date: '2026-12-31', count: 0, level: 0 },
        ]);
    });

    it('does not duplicate an endpoint that already has an event', () => {
        const data = toCalendarData([{ date: '2026-12-31', count: 5 }], RANGE);
        expect(data).toEqual([
            { date: '2026-01-01', count: 0, level: 0 },
            { date: '2026-12-31', count: 5, level: 4 },
        ]);
    });
});
