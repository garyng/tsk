import fs from 'node:fs';
import net from 'node:net';
import { onExit } from 'signal-exit';
import { processStart } from '../lib/process-start';
import {
    isAlive,
    MAX_REQUEST,
    makeRuntimeDir,
    parseRequest,
    readRecords,
    recordPath,
    replyLine,
    type SelectReply,
    socketPath,
    type TuiRecord,
} from '../lib/tui-channel';

/** A connection that sends no whole line in this long is dropped. */
const REQUEST_TIMEOUT_MS = 2000;

export interface ListenOptions {
    readonly dir: string;
    /** What the record says the TUI shows. */
    readonly shows: Pick<TuiRecord, 'file' | 'followPid' | 'session' | 'tmux'>;
    /** Answer a request to select task `id`. */
    onSelect(id: string): SelectReply;
    /** A request that failed on the way, or the socket itself. */
    onError(e: Error): void;
}

const unlinkQuietly = (file: string) => {
    try {
        fs.unlinkSync(file);
    } catch (e) {
        // Already gone is what we wanted.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
};

/**
 * Listen for requests from outside (`lib/tui-channel.ts`): the socket first,
 * then the record naming it, so whoever reads the record can connect. A dead
 * TUI's leftovers are removed on the way in. Resolves to a function that stops
 * listening and removes both, which also runs when the process exits.
 */
export async function listenForRequests(opts: ListenOptions): Promise<() => void> {
    const { dir } = opts;
    makeRuntimeDir(dir);
    for (const r of readRecords(dir)) {
        if (isAlive(r)) continue;
        unlinkQuietly(socketPath(dir, r.pid));
        unlinkQuietly(recordPath(dir, r.pid));
    }
    const pid = process.pid;
    const socket = socketPath(dir, pid);
    const record = recordPath(dir, pid);
    // Ours: a process that had this pid before is gone.
    unlinkQuietly(socket);

    const server = net.createServer((conn) => {
        let got = '';
        let answered = false;
        const answer = (r: SelectReply) => {
            answered = true;
            conn.end(replyLine(r));
        };
        conn.setEncoding('utf8');
        conn.setTimeout(REQUEST_TIMEOUT_MS, () => conn.destroy());
        conn.on('data', (chunk: string) => {
            if (answered) return;
            got += chunk;
            const end = got.indexOf('\n');
            if (end < 0) {
                if (got.length > MAX_REQUEST) answer({ ok: false, why: 'request too long' });
                return;
            }
            const req = parseRequest(got.slice(0, end));
            if ('why' in req) {
                answer({ ok: false, why: req.why });
                return;
            }
            try {
                answer(opts.onSelect(req.id));
            } catch (e) {
                opts.onError(e as Error);
                answer({ ok: false, why: `the TUI failed: ${(e as Error).message}` });
            }
        });
        conn.on('error', (e) => opts.onError(new Error(`a request's connection: ${e.message}`)));
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socket, () => {
            server.off('error', reject);
            resolve();
        });
    });
    server.on('error', opts.onError);

    const body: TuiRecord = { pid, procStart: processStart(pid), ...opts.shows };
    // Renamed into place, so a reader never sees half a record.
    fs.writeFileSync(`${record}.tmp`, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    fs.renameSync(`${record}.tmp`, record);

    const remove = () => {
        unlinkQuietly(record);
        unlinkQuietly(socket);
    };
    const unhook = onExit(remove);
    return () => {
        unhook();
        server.close();
        remove();
    };
}
