import { readFile, stat } from 'node:fs/promises';
import * as vscode from 'vscode';

/**
 * Filesystem reads that skip `vscode.workspace.fs` for ordinary local files.
 *
 * **Why (measured on a ~100k-file monorepo):** the initial workspace scan spent
 * **9.1 seconds on seven `vscode.workspace.fs.stat` calls** — about 1.3s each —
 * while `node:fs` stats the same files in ~5µs. `workspace.fs` is an RPC into
 * the file-system-provider registry, and at activation that channel is
 * contended by every other extension starting up; the cost is the queue, not
 * the disk. The same scan's SQLite and graph work totals ~24ms, so this was
 * essentially the whole of tsk's startup time.
 *
 * `workspace.fs` is still the right call for anything that isn't a plain local
 * file (virtual filesystems, remote providers, untitled docs), so the scheme
 * guard decides and the RPC stays as the fallback. A node-only extension host
 * is a safe assumption here — tsk already uses `node:fs` for the cache
 * directory, `node:child_process` for git history, and `node:sqlite` for both
 * stores.
 */

/**
 * Modification time in integer milliseconds since the epoch — the same shape
 * `vscode.FileStat.mtime` reports, so a cache written through either path
 * compares equal. (`node:fs` exposes a fractional `mtimeMs`; flooring it is
 * what keeps a mixed-provenance cache from seeing phantom changes.)
 */
export async function statMtime(uri: vscode.Uri): Promise<number> {
    if (uri.scheme === 'file') {
        return Math.floor((await stat(uri.fsPath)).mtimeMs);
    }
    return (await vscode.workspace.fs.stat(uri)).mtime;
}

/** A file's contents as text, decoded as UTF-8. */
export async function readText(uri: vscode.Uri): Promise<string> {
    const bytes =
        uri.scheme === 'file'
            ? await readFile(uri.fsPath)
            : await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes);
}

/**
 * Does `uri` exist? `false` on any read error — a probe, not a diagnosis.
 */
export async function uriExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await statMtime(uri);
        return true;
    } catch {
        return false;
    }
}

/**
 * Is this error "the file isn't there"? The two providers spell it
 * differently — `node:fs` throws `ENOENT`, `vscode.workspace.fs` throws
 * `FileNotFound` — so callers that treat a missing file as a normal outcome
 * must not hardcode either. This is the policy that keeps the choice of
 * provider invisible to them.
 */
export function isFileNotFound(error: unknown): boolean {
    const code = (error as { code?: string }).code;
    return code === 'ENOENT' || code === 'FileNotFound';
}
