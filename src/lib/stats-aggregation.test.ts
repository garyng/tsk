import { describe, expect, it } from 'vitest';
import { bucketByDay, buildStatsSeries, EVENT_METRICS } from './stats-aggregation';

/** A metadata row, the structural shape the aggregation consumes. */
const meta = (key: string, value: string | null) => ({ key, value });

describe('bucketByDay', () => {
    it('buckets matching keys by their local calendar day', () => {
        const buckets = bucketByDay(
            [
                meta('completed', '2026-05-24T09:00:00+08:00'),
                meta('completed', '2026-05-24T23:30:00+08:00'),
                meta('completed', '2026-05-25T08:00:00+08:00'),
            ],
            new Set(['completed']),
        );
        expect(buckets.get('2026-05-24')).toBe(2);
        expect(buckets.get('2026-05-25')).toBe(1);
    });

    it('ignores keys outside the requested set', () => {
        const buckets = bucketByDay(
            [
                meta('created', '2026-05-24T09:00:00+08:00'),
                meta('completed', '2026-05-24T09:00:00+08:00'),
            ],
            new Set(['completed']),
        );
        expect(buckets.get('2026-05-24')).toBe(1);
    });

    it('skips null values and malformed dates', () => {
        const buckets = bucketByDay(
            [
                meta('completed', null),
                meta('completed', ''),
                meta('completed', 'not-a-date'),
                meta('completed', '2026-05-24T09:00:00+08:00'),
            ],
            new Set(['completed']),
        );
        expect(buckets.get('2026-05-24')).toBe(1);
        expect(buckets.size).toBe(1);
    });

    it('buckets by the written date prefix, not a UTC re-projection', () => {
        // 01:00 at +08:00 is the previous day in UTC; we keep the written day.
        const buckets = bucketByDay(
            [meta('started', '2026-05-24T01:00:00+08:00')],
            new Set(['started']),
        );
        expect(buckets.get('2026-05-24')).toBe(1);
        expect(buckets.has('2026-05-23')).toBe(false);
    });

    it('is empty for no rows', () => {
        expect(bucketByDay([], new Set(EVENT_METRICS)).size).toBe(0);
    });
});

describe('buildStatsSeries', () => {
    const rows = [
        meta('created', '2026-05-24T09:00:00+08:00'),
        meta('created', '2026-05-25T09:00:00+08:00'),
        meta('started', '2026-05-25T10:00:00+08:00'),
        meta('completed', '2026-05-25T18:00:00+08:00'),
        meta('id', 'abc'), // non-temporal — ignored
        meta('parent', 'xyz'), // non-temporal — ignored
    ];

    it('produces a sorted DayCount[] per event metric', () => {
        const series = buildStatsSeries(rows);
        expect(series.created).toEqual([
            { date: '2026-05-24', count: 1 },
            { date: '2026-05-25', count: 1 },
        ]);
        expect(series.started).toEqual([{ date: '2026-05-25', count: 1 }]);
        expect(series.completed).toEqual([{ date: '2026-05-25', count: 1 }]);
        expect(series.cancelled).toEqual([]);
        expect(series.moved).toEqual([]);
    });

    it('combines all events per day in the "all" series', () => {
        const series = buildStatsSeries(rows);
        // 05-24: 1 created. 05-25: created + started + completed = 3.
        expect(series.all).toEqual([
            { date: '2026-05-24', count: 1 },
            { date: '2026-05-25', count: 3 },
        ]);
    });

    it('has a key for every metric plus "all"', () => {
        const series = buildStatsSeries([]);
        for (const metric of EVENT_METRICS) expect(series[metric]).toEqual([]);
        expect(series.all).toEqual([]);
    });

    it('accepts a one-shot iterable', () => {
        function* gen() {
            yield meta('created', '2026-05-24T09:00:00+08:00');
        }
        expect(buildStatsSeries(gen()).created).toEqual([{ date: '2026-05-24', count: 1 }]);
    });
});
