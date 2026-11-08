import { describe, expect, it } from 'vitest';
import { FRESH_FOR_MS, isFresh, readStatus } from './status';
import { StatusCache } from './status-cache';

describe('readStatus', () => {
    it('keeps what it knows, and drops what is malformed but optional', () => {
        expect(
            readStatus({
                label: ' In review ',
                category: 'inProgress',
                checks: 'failing',
                title: 'T',
                lines: ['a', 3],
            }),
        ).toEqual({
            label: 'In review',
            category: 'inProgress',
            checks: 'failing',
            title: 'T',
            lines: ['a'],
        });
        expect(readStatus({ label: 'x', category: 'weird', checks: 'green' })).toEqual({
            label: 'x',
            category: 'unknown',
        });
    });

    it('refuses an answer with no label', () => {
        expect(readStatus({ category: 'done' })).toEqual({ why: 'no "label"' });
        expect(readStatus('done')).toEqual({ why: 'not an object' });
    });
});

describe('isFresh', () => {
    const status = (category: 'open' | 'done') => ({
        status: { label: category, category },
        fetchedAt: 0,
    });

    it('trusts a finished item longer than an open one, and an error least', () => {
        expect(isFresh(status('open'), FRESH_FOR_MS.open - 1)).toBe(true);
        expect(isFresh(status('open'), FRESH_FOR_MS.open)).toBe(false);
        expect(isFresh(status('done'), FRESH_FOR_MS.open)).toBe(true);
        expect(isFresh({ error: 'x', fetchedAt: 0 }, FRESH_FOR_MS.error)).toBe(false);
    });
});

describe('StatusCache', () => {
    it('drops the URL written longest ago past its size', () => {
        const cache = new StatusCache(2);
        const e = (n: number) => ({ error: `e${n}`, fetchedAt: n });
        cache.set('a', e(1));
        cache.set('b', e(2));
        cache.set('a', e(3));
        cache.set('c', e(4));
        expect(cache.toJSON().map(([url]) => url)).toEqual(['a', 'c']);
    });

    it('drops what it is told to, or everything', () => {
        const cache = new StatusCache();
        for (const url of ['https://a/1', 'https://b/1', 'https://a/2'])
            cache.set(url, { error: 'x', fetchedAt: 0 });
        expect(cache.prune((url) => url.startsWith('https://a/'))).toBe(1);
        expect(cache.toJSON().map(([url]) => url)).toEqual(['https://a/1', 'https://a/2']);
        cache.clear();
        expect(cache.size).toBe(0);
    });

    it('comes back from what it stored, leaving out anything malformed', () => {
        const cache = new StatusCache();
        cache.set('a', { status: { label: 'open', category: 'open' }, fetchedAt: 5 });
        cache.set('b', { error: 'gone', fetchedAt: 6 });
        const stored = JSON.parse(
            JSON.stringify([...cache.toJSON(), ['c', { fetchedAt: 'x' }], 'd']),
        );
        expect(StatusCache.from(stored).toJSON()).toEqual(cache.toJSON());
        expect(StatusCache.from(undefined).size).toBe(0);
    });
});
