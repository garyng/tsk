import { describe, expect, it } from 'vitest';
import { bucketByDay, buildStatsSeries, EVENT_METRICS, taskIdsForDay } from './stats-aggregation';

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

describe('taskIdsForDay', () => {
    const m = (taskId: string, key: string, value: string | null) => ({ taskId, key, value });
    const ROWS = [
        m('a', 'created', '2026-05-24T09:00:00+08:00'),
        m('b', 'created', '2026-05-24T20:00:00+08:00'),
        m('a', 'completed', '2026-05-25T10:00:00+08:00'),
        m('c', 'completed', '2026-05-24T10:00:00+08:00'),
        m('d', 'started', '2026-05-24T10:00:00+08:00'),
        m('b', 'priority', '2'), // a non-event key — ignored
    ];

    it('returns the task ids with that metric event on that day', () => {
        expect(taskIdsForDay(ROWS, 'created', '2026-05-24').sort()).toEqual(['a', 'b']);
        expect(taskIdsForDay(ROWS, 'completed', '2026-05-24')).toEqual(['c']);
        expect(taskIdsForDay(ROWS, 'completed', '2026-05-25')).toEqual(['a']);
    });

    it('"all" unions every event type that day, deduped', () => {
        expect(taskIdsForDay(ROWS, 'all', '2026-05-24').sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('is empty for a day (or metric) with no matching events', () => {
        expect(taskIdsForDay(ROWS, 'created', '2026-06-01')).toEqual([]);
        expect(taskIdsForDay(ROWS, 'moved', '2026-05-24')).toEqual([]);
    });
});
