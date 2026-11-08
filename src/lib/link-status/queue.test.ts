import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Connector, FetchQueue, RateLimited } from './queue';
import type { Entry } from './status';

/** A connector whose batches wait until the test settles them. */
function connector(name: string, prefix: string, batchSize = 2) {
    const asked: string[][] = [];
    const pending: { urls: readonly string[]; settle: (a: Map<string, Answer> | Error) => void }[] =
        [];
    const c: Connector = {
        name,
        batchSize,
        matches: (url) => url.startsWith(prefix),
        fetch: (urls) => {
            asked.push([...urls]);
            return new Promise((resolve, reject) =>
                pending.push({
                    urls,
                    settle: (a) => (a instanceof Error ? reject(a) : resolve(a)),
                }),
            );
        },
    };
    /** Settle the oldest waiting batch: each URL `done`, or the error. */
    const answer = async (a?: Error) => {
        const p = pending.shift();
        p?.settle(
            a ?? new Map(p.urls.map((u) => [u, { label: 'done', category: 'done' as const }])),
        );
        await vi.advanceTimersByTimeAsync(0);
    };
    return { c, asked, pending, answer };
}

describe('FetchQueue', () => {
    let entries: [string, Entry][];
    let now: number;
    const log = { info: vi.fn(), warn: vi.fn() };
    beforeEach(() => {
        vi.useFakeTimers();
        entries = [];
        now = 1000;
    });
    afterEach(() => vi.useRealTimers());
    const queue = (...cs: Connector[]) =>
        new FetchQueue(cs, {
            now: () => now,
            onEntry: (u, e) => entries.push([u, e]),
            log,
            maxConcurrent: 1,
        });

    it('batches by the connector, one request at a time, asking for each URL once', async () => {
        const gh = connector('gh', 'https://gh/');
        const q = queue(gh.c);
        q.want(['https://gh/1', 'https://gh/2', 'https://gh/3', 'https://gh/1', 'https://other/1']);
        q.want(['https://gh/2', 'https://gh/4']);
        expect(gh.asked).toEqual([['https://gh/1', 'https://gh/2']]);
        expect(q.pending).toBe(4);
        await gh.answer();
        expect(gh.asked.at(-1)).toEqual(['https://gh/3', 'https://gh/4']);
        await gh.answer();
        expect(entries.map(([u]) => u)).toEqual([
            'https://gh/1',
            'https://gh/2',
            'https://gh/3',
            'https://gh/4',
        ]);
        expect(q.pending).toBe(0);
        expect(q.knows('https://other/1')).toBe(false);
    });

    it('gives the first connector that matches the URL, so one of yours can take over a host', () => {
        const mine = connector('mine', 'https://gh/o/');
        const gh = connector('gh', 'https://gh/');
        queue(mine.c, gh.c).want(['https://gh/o/1', 'https://gh/x/1']);
        expect([mine.asked, gh.asked]).toEqual([[['https://gh/o/1']], [['https://gh/x/1']]]);
    });

    it('records a URL left out of the answer, and a failed batch, as errors', async () => {
        const gh = connector('gh', 'https://gh/');
        queue(gh.c).want(['https://gh/1', 'https://gh/2', 'https://gh/3']);
        gh.pending
            .shift()
            ?.settle(new Map([['https://gh/1', { label: 'open', category: 'open' }]]));
        await vi.advanceTimersByTimeAsync(0);
        await gh.answer(new Error('HTTP 500'));
        expect(entries).toEqual([
            ['https://gh/1', { status: { label: 'open', category: 'open' }, fetchedAt: 1000 }],
            ['https://gh/2', { error: 'no status from gh', fetchedAt: 1000 }],
            ['https://gh/3', { error: 'HTTP 500', fetchedAt: 1000 }],
        ]);
    });

    it('pauses a rate-limited connector until it may ask again, the batch first in line', async () => {
        const gh = connector('gh', 'https://gh/', 1);
        const q = queue(gh.c);
        q.want(['https://gh/1', 'https://gh/2']);
        await gh.answer(new RateLimited(now + 60_000));
        q.want(['https://gh/3']);
        expect(gh.asked).toEqual([['https://gh/1']]);
        now += 60_000;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(gh.asked).toEqual([['https://gh/1'], ['https://gh/1']]);
        await gh.answer();
        await gh.answer();
        expect(gh.asked.at(-1)).toEqual(['https://gh/3']);
    });

    it('drops what comes back after it is disposed', async () => {
        const gh = connector('gh', 'https://gh/');
        const q = queue(gh.c);
        q.want(['https://gh/1']);
        q.dispose();
        await gh.answer();
        expect(entries).toEqual([]);
    });
});
