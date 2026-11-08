import { type Entry, readStatus } from './status';

/**
 * Every URL's last known {@link Entry}, kept across reloads (the editor layer
 * stores {@link StatusCache.toJSON} in `globalState`). At most `max` URLs:
 * the one written longest ago goes first.
 */
export class StatusCache {
    private readonly entries = new Map<string, Entry>();

    constructor(private readonly max = 2000) {}

    get(url: string): Entry | undefined {
        return this.entries.get(url);
    }

    set(url: string, entry: Entry): void {
        // Map keeps insertion order: re-inserting moves the URL to the newest end.
        this.entries.delete(url);
        this.entries.set(url, entry);
        for (const oldest of this.entries.keys()) {
            if (this.entries.size <= this.max) break;
            this.entries.delete(oldest);
        }
    }

    get size(): number {
        return this.entries.size;
    }

    toJSON(): [string, Entry][] {
        return [...this.entries];
    }

    /** A cache from what {@link toJSON} stored; anything malformed is left out. */
    static from(raw: unknown, max?: number): StatusCache {
        const cache = new StatusCache(max);
        if (!Array.isArray(raw)) return cache;
        for (const item of raw) {
            if (!Array.isArray(item) || typeof item[0] !== 'string') continue;
            const e = item[1] as Record<string, unknown> | null;
            if (!e || typeof e.fetchedAt !== 'number') continue;
            if (typeof e.error === 'string') {
                cache.set(item[0], { error: e.error, fetchedAt: e.fetchedAt });
                continue;
            }
            const status = readStatus(e.status);
            if (!('why' in status)) cache.set(item[0], { status, fetchedAt: e.fetchedAt });
        }
        return cache;
    }
}
