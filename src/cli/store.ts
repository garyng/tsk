import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';
import { buildTaskTree, type OutsideFile, type TaskTree, withOutside } from '../lib/task-tree';

/**
 * The one way the `tsk` command line changes a `.tsk` file that several
 * writers share (Claude sessions, the TUI). The policy lives here, the
 * libraries underneath are replaceable:
 *
 * - **Lock** with `proper-lockfile` — a `<file>.lock` directory (an atomic
 *   `mkdir`, so it works across processes with no native code), refreshed
 *   while held and treated as stale after {@link STALE_MS}. Node has no
 *   `flock`; this is the de-facto standard, also what Backlog.md uses.
 * - **Re-read under the lock**, then apply the edit: the caller never acts on
 *   text read before another writer finished.
 * - **Write atomically** with `write-file-atomic` (temp file in the same
 *   directory, fsync, rename), so a reader — the TUI, VS Code — never sees a
 *   half-written file. A rename swaps the inode, which is why watchers must
 *   watch the directory.
 *
 * The lock is advisory: editors ignore it. VS Code and vim both refuse to
 * overwrite a file that changed under a dirty buffer without asking, which is
 * what keeps a person's edit and a CLI write from silently clobbering.
 */

/** A crashed holder's lock is ignored after this long. Every edit takes milliseconds. */
const STALE_MS = 10_000;
/** Waiting for another writer: ~50 tries over a few seconds before giving up. */
const LOCK_RETRIES = { retries: 50, minTimeout: 20, maxTimeout: 100 };

export class StoreError extends Error {}

export interface Doc {
    readonly lines: string[];
    readonly eol: '\n' | '\r\n';
}

export function splitDoc(text: string): Doc {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    return { lines: text.split(eol), eol };
}

export function joinDoc(doc: Doc): string {
    return doc.lines.join(doc.eol);
}

/** The file's lines, or none when it doesn't exist yet. */
export function readDoc(file: string): Doc {
    try {
        return splitDoc(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [''], eol: '\n' };
        throw e;
    }
}

/**
 * The other `.tsk` files in `file`'s directory, read without a lock (a
 * snapshot is all a lookup needs), in name order; one that can't be read is
 * left out and named in `warnings`.
 */
export function readOutside(file: string): { files: OutsideFile[]; warnings: string[] } {
    const dir = path.dirname(path.resolve(file));
    const own = path.basename(file);
    const files: OutsideFile[] = [];
    const warnings: string[] = [];
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch (e) {
        return { files, warnings: [`couldn't list ${dir}: ${(e as Error).message}`] };
    }
    for (const name of names.filter((n) => n.endsWith('.tsk') && n !== own).sort()) {
        const other = path.join(dir, name);
        try {
            if (!fs.statSync(other).isFile()) continue;
            files.push({
                file: other,
                tree: buildTaskTree(splitDoc(fs.readFileSync(other, 'utf8')).lines),
            });
        } catch (e) {
            warnings.push(`couldn't read ${name}: ${(e as Error).message}`);
        }
    }
    return { files, warnings };
}

/** `lines` of `file` as a tree, looking up the ids it names in the files beside it. */
export function treeWithOutside(
    lines: readonly string[],
    outside: readonly OutsideFile[],
): TaskTree {
    return withOutside(buildTaskTree(lines), outside);
}

export interface Edit<T> {
    /** The new lines, or `undefined` to leave the file untouched. */
    readonly lines: string[] | undefined;
    readonly result: T;
}

/** Lock `file`, re-read it, apply `edit`, write the result atomically, unlock. Creates the file if missing. */
export async function updateDoc<T>(
    file: string,
    edit: (lines: readonly string[]) => Edit<T>,
): Promise<T> {
    try {
        fs.writeFileSync(file, '', { flag: 'wx' });
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let compromised: Error | undefined;
    let release: () => Promise<void>;
    try {
        release = await lockfile.lock(file, {
            stale: STALE_MS,
            retries: LOCK_RETRIES,
            onCompromised: (err) => {
                compromised = err;
            },
        });
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ELOCKED') {
            throw new StoreError(
                `${file} is locked by another tsk (${file}.lock); if none is running, the lock goes stale after ${STALE_MS / 1000} s`,
            );
        }
        throw e;
    }
    try {
        const doc = readDoc(file);
        const { lines, result } = edit(doc.lines);
        if (lines !== undefined) {
            if (compromised)
                throw new StoreError(
                    `lost the lock on ${file} (${compromised.message}); nothing written`,
                );
            await writeFileAtomic(file, joinDoc({ lines, eol: doc.eol }), { fsync: true });
        }
        return result;
    } finally {
        await release().catch((e: Error) =>
            console.warn(`tsk: releasing the lock on ${file} failed: ${e.message}`),
        );
    }
}
