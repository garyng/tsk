import { describe, expect, it } from 'vitest';
import type { Marker } from './markers';
import { buildStatsView } from './stats-view-model';

const TODAY = new Date('2026-06-07T12:00:00');

const meta = (key: string, value: string | null) => ({ key, value });

describe('buildStatsView', () => {
    it('tiles every marker in registry order with counts, plus a total', () => {
        const view = buildStatsView(
            [{ marker: 'todo' }, { marker: 'todo' }, { marker: 'completed' }] satisfies {
                marker: Marker;
            }[],
            [],
            TODAY,
        );
        expect(view.tiles.map((t) => t.marker)).toEqual([
            'todo',
            'inprogress',
            'completed',
            'moved',
            'cancelled',
            'notes',
        ]);
        expect(view.tiles.find((t) => t.marker === 'todo')).toEqual({
            marker: 'todo',
            label: 'Todo',
            count: 2,
        });
        expect(view.tiles.find((t) => t.marker === 'completed')?.count).toBe(1);
        expect(view.tiles.find((t) => t.marker === 'inprogress')?.count).toBe(0);
        expect(view.total).toBe(3);
    });

    it('spans a 365-day inclusive trailing window ending today', () => {
        const view = buildStatsView([], [], TODAY);
        expect(view.range).toEqual({ from: '2025-06-08', to: '2026-06-07' });
    });

    it('carries the per-metric series (incl. the combined `all`) from the metadata', () => {
        const view = buildStatsView(
            [],
            [
                meta('created', '2026-05-24T09:00:00+08:00'),
                meta('completed', '2026-05-24T18:00:00+08:00'),
            ],
            TODAY,
        );
        expect(view.series.created).toEqual([{ date: '2026-05-24', count: 1 }]);
        expect(view.series.all).toEqual([{ date: '2026-05-24', count: 2 }]);
        expect(view.series.started).toEqual([]);
    });
});
