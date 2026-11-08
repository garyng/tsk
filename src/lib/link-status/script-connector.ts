import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { Answer, Connector } from './queue';
import { readStatus } from './status';

/**
 * Connectors of the user's own, from `tsk.linkStatus.connectors`: a program per URL pattern. tsk
 * writes a batch's URLs to its stdin, one per line, and reads one JSON object
 * per line from its stdout, each naming its `url`: the status shape
 * (`label`, `category`, `checks`, `title`, `lines`), or `error`.
 */

export interface ScriptConnectorConfig {
    readonly name: string;
    readonly match: RegExp;
    /** The program and its arguments, run without a shell. */
    readonly command: readonly string[];
    readonly batchSize: number;
}

export const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 100;
export const SCRIPT_TIMEOUT_MS = 30_000;
/** More than any batch's answer should be; past it the program is stopped. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** The setting's entries as connectors; a malformed one is left out with a warning, as autolinks do. */
export function parseScriptConnectors(raw: unknown): {
    configs: ScriptConnectorConfig[];
    warnings: string[];
} {
    const configs: ScriptConnectorConfig[] = [];
    const warnings: string[] = [];
    if (raw === undefined || raw === null) return { configs, warnings };
    if (!Array.isArray(raw))
        return { configs, warnings: ['tsk.linkStatus.connectors: expected an array.'] };
    for (const [i, entry] of raw.entries()) {
        const at = `tsk.linkStatus.connectors[${i}]`;
        const e = entry as Record<string, unknown> | null;
        if (!e || typeof e !== 'object' || Array.isArray(e)) {
            warnings.push(`${at}: not an object.`);
            continue;
        }
        const name = typeof e.name === 'string' && e.name.trim() !== '' ? e.name.trim() : undefined;
        if (!name) {
            warnings.push(`${at}: "name" must be a non-empty string.`);
            continue;
        }
        let match: RegExp;
        try {
            if (typeof e.match !== 'string' || e.match === '')
                throw new Error('must be a non-empty string');
            match = new RegExp(e.match);
        } catch (err) {
            warnings.push(`${at} (${name}): "match" ${(err as Error).message}.`);
            continue;
        }
        const command = e.command;
        if (
            !Array.isArray(command) ||
            command.length === 0 ||
            !command.every((c) => typeof c === 'string' && c !== '')
        ) {
            warnings.push(`${at} (${name}): "command" must be a non-empty array of strings.`);
            continue;
        }
        const size = e.batchSize;
        const batchSize =
            Number.isInteger(size) && (size as number) >= 1
                ? Math.min(size as number, MAX_BATCH_SIZE)
                : DEFAULT_BATCH_SIZE;
        if (size !== undefined && size !== batchSize)
            warnings.push(`${at} (${name}): "batchSize" is ${batchSize}.`);
        configs.push({ name, match, command, batchSize });
    }
    return { configs, warnings };
}

export interface ScriptIo {
    /** Each line the program writes to stderr, and each line of its stdout that isn't an answer. */
    readonly log: (line: string) => void;
    /** Where the program runs, so a relative path in `command` is from there: the workspace folder. */
    readonly cwd?: string;
    readonly timeoutMs?: number;
}

export function scriptConnector(config: ScriptConnectorConfig, io: ScriptIo): Connector {
    return {
        name: config.name,
        batchSize: config.batchSize,
        matches: (url) => config.match.test(url),
        fetch: (urls, signal) => runScript(config, urls, signal, io),
    };
}

/** `~/` at the start of the program's path is the home folder, as a shell would have it. */
const expandHome = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

function runScript(
    config: ScriptConnectorConfig,
    urls: readonly string[],
    signal: AbortSignal,
    io: ScriptIo,
): Promise<Map<string, Answer>> {
    const [program = '', ...args] = config.command;
    const timeoutMs = io.timeoutMs ?? SCRIPT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        // Its own process group, so stopping it stops what it started too: a child left
        // holding its stdout would keep the batch waiting.
        const child = spawn(expandHome(program), args, {
            cwd: io.cwd,
            stdio: 'pipe',
            detached: true,
        });
        let out = '';
        let err = '';
        let settled = false;
        const settle = (finish: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            finish();
        };
        const stop = (why: string) => {
            try {
                if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
            } catch (e) {
                // ESRCH: it has exited already, which is what stopping wanted.
                if ((e as NodeJS.ErrnoException).code !== 'ESRCH') io.log(`${config.name}: ${e}`);
            }
            settle(() => reject(new Error(why)));
        };
        const onAbort = () => stop('stopped');
        signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(
            () => stop(`didn't answer within ${timeoutMs / 1000} s`),
            timeoutMs,
        );
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            out += chunk;
            if (out.length > MAX_OUTPUT_BYTES) stop(`wrote more than ${MAX_OUTPUT_BYTES} bytes`);
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            err += chunk;
        });
        child.on('error', (e) =>
            settle(() => reject(new Error(`can't run ${program}: ${e.message}`))),
        );
        child.on('close', (code, sig) => {
            const errLines = err.split('\n').filter((l) => l.trim() !== '');
            for (const line of errLines) io.log(`${config.name}: ${line}`);
            settle(() => {
                if (code === 0)
                    resolve(
                        readAnswers(out, new Set(urls), (line) =>
                            io.log(`${config.name}: ${line}`),
                        ),
                    );
                else
                    reject(
                        new Error(
                            `exited ${code ?? sig}${errLines.length > 0 ? `: ${errLines.at(-1)}` : ''}`,
                        ),
                    );
            });
        });
        // A program that exits without reading its input closes the pipe: that's its answer, not ours.
        child.stdin.on('error', () => {});
        child.stdin.end(`${urls.join('\n')}\n`);
    });
}

/** The answers in a program's output, for the URLs it was asked about; anything else is logged. */
export function readAnswers(
    out: string,
    asked: ReadonlySet<string>,
    log: (line: string) => void,
): Map<string, Answer> {
    const answers = new Map<string, Answer>();
    for (const line of out.split('\n')) {
        if (line.trim() === '') continue;
        let raw: unknown;
        try {
            raw = JSON.parse(line);
        } catch {
            log(`not JSON: ${line}`);
            continue;
        }
        const url = (raw as { url?: unknown } | null)?.url;
        if (typeof url !== 'string' || !asked.has(url)) {
            log(`an answer for a URL it wasn't asked about: ${line}`);
            continue;
        }
        const error = (raw as { error?: unknown }).error;
        if (typeof error === 'string' && error !== '') {
            answers.set(url, { error });
            continue;
        }
        const status = readStatus(raw);
        answers.set(url, 'why' in status ? { error: `its answer has ${status.why}` } : status);
    }
    return answers;
}
