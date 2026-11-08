import type { Entry, LinkStatus } from './status';

/** What a connector answers for a URL: its status, or why it has none. */
export type Answer = LinkStatus | { readonly error: string };

/** Something that can find the status of the links it knows. */
export interface Connector {
    readonly name: string;
    matches(url: string): boolean;
    /** At most this many URLs per {@link fetch}. */
    readonly batchSize: number;
    /**
     * Each URL's answer; one left out has no status. Throws {@link RateLimited}
     * to pause this connector, anything else to fail the batch.
     */
    fetch(urls: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, Answer>>;
}

/** The service asked tsk to wait: nothing more goes to this connector until `until` (epoch ms). */
export class RateLimited extends Error {
    constructor(
        readonly until: number,
        message = 'rate limited',
    ) {
        super(message);
    }
}

export interface QueueDeps {
    readonly now: () => number;
    /** Each URL's entry, as its batch comes back. */
    readonly onEntry: (url: string, entry: Entry) => void;
    readonly log: { info(message: string): void; warn(message: string): void };
    /** Requests in flight per connector at once. */
    readonly maxConcurrent?: number;
}

interface Lane {
    readonly connector: Connector;
    /** Waiting, in the order they were asked for. */
    readonly queued: Set<string>;
    readonly inFlight: Set<string>;
    running: number;
    pausedUntil: number;
    timer?: ReturnType<typeof setTimeout>;
}

/**
 * The URLs waiting for a status, a lane per connector: each URL is asked for
 * once while it waits or is in flight, in batches of the connector's size, a
 * few requests at a time. The first connector that matches a URL takes it.
 */
export class FetchQueue {
    private readonly lanes: Lane[];
    private readonly abort = new AbortController();

    constructor(
        connectors: readonly Connector[],
        private readonly deps: QueueDeps,
    ) {
        this.lanes = connectors.map((connector) => ({
            connector,
            queued: new Set(),
            inFlight: new Set(),
            running: 0,
            pausedUntil: 0,
        }));
    }

    /** Whether some connector takes `url`. */
    knows(url: string): boolean {
        return this.lanes.some((l) => l.connector.matches(url));
    }

    /** Ask for these URLs' status; one already waiting or in flight isn't asked for twice. */
    want(urls: Iterable<string>): void {
        const touched = new Set<Lane>();
        for (const url of urls) {
            if (this.lanes.some((l) => l.queued.has(url) || l.inFlight.has(url))) continue;
            const lane = this.lanes.find((l) => l.connector.matches(url));
            if (!lane) continue;
            lane.queued.add(url);
            touched.add(lane);
        }
        for (const lane of touched) this.pump(lane);
    }

    /** Waiting or in flight, all connectors together. */
    get pending(): number {
        return this.lanes.reduce((n, l) => n + l.queued.size + l.inFlight.size, 0);
    }

    dispose(): void {
        this.abort.abort();
        for (const lane of this.lanes) clearTimeout(lane.timer);
    }

    private pump(lane: Lane): void {
        if (this.abort.signal.aborted) return;
        const max = this.deps.maxConcurrent ?? 2;
        const wait = lane.pausedUntil - this.deps.now();
        if (wait > 0) {
            lane.timer ??= setTimeout(() => {
                lane.timer = undefined;
                this.pump(lane);
            }, wait);
            return;
        }
        while (lane.running < max && lane.queued.size > 0) {
            const batch = [...lane.queued].slice(0, lane.connector.batchSize);
            for (const url of batch) {
                lane.queued.delete(url);
                lane.inFlight.add(url);
            }
            lane.running++;
            void this.run(lane, batch);
        }
    }

    private async run(lane: Lane, batch: string[]): Promise<void> {
        const { connector } = lane;
        const started = this.deps.now();
        try {
            const answers = await connector.fetch(batch, this.abort.signal);
            if (this.abort.signal.aborted) return;
            const at = this.deps.now();
            for (const url of batch) {
                const a = answers.get(url) ?? { error: `no status from ${connector.name}` };
                this.deps.onEntry(
                    url,
                    'error' in a ? { error: a.error, fetchedAt: at } : { status: a, fetchedAt: at },
                );
            }
            this.deps.log.info(
                `link status: ${connector.name} answered ${answers.size} of ${batch.length} in ${at - started} ms`,
            );
        } catch (e) {
            if (this.abort.signal.aborted) return;
            if (e instanceof RateLimited) {
                // Back in line, first: they were asked for before anything queued since.
                lane.pausedUntil = e.until;
                const later = [...lane.queued];
                lane.queued.clear();
                for (const url of [...batch, ...later]) lane.queued.add(url);
                this.deps.log.warn(
                    `link status: ${connector.name}: ${e.message}; paused until ${new Date(e.until).toISOString()}`,
                );
            } else {
                const why = (e as Error).message;
                const at = this.deps.now();
                for (const url of batch) this.deps.onEntry(url, { error: why, fetchedAt: at });
                this.deps.log.warn(`link status: ${connector.name} failed ${batch.length}: ${why}`);
            }
        } finally {
            for (const url of batch) lane.inFlight.delete(url);
            lane.running--;
            this.pump(lane);
        }
    }
}
