/**
 * Git-history derivation for the Markdown→tsk migration: for one md task
 * line, reconstruct WHEN it was added (`@created`) and when it last entered
 * its current marker (`@completed` / `@cancelled` / `@moved` / `@started`),
 * from `git log --reverse -L<n>,<n>:<file>` output.
 *
 * Why `-L`, not blame: blame gives only the LAST touch — right for a flipped
 * task's status stamp, wrong for `@created` once a line was ever reworded or
 * flipped. `-L` range-tracking replays the line's whole history (it even
 * follows file renames; the spike showed pure-rename commits don't appear at
 * all — only commits that touched the line do).
 *
 * Split: pure parsing/derivation (unit-tested on captured `git log` output)
 * + a thin `execFile` runner at the bottom (node-only, no vscode — exercised
 * against a real scripted repo in the unit suite, like the SQLite stores).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Marker } from './markers';
import { type MdStamps, matchMdTask } from './md-migrate';

const execFileAsync = promisify(execFile);

/** Sentinel prefixing each commit in our `git log` format string. */
const COMMIT_PREFIX = 'COMMIT ';
/** Histories are long; 10 MB headroom over execFile's 1 MB default. */
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

/** One commit that touched the tracked line: when, and the line's content AFTER it. */
export interface GitLineEntry {
    hash: string;
    /** Author date, `%aI` strict ISO with the author's own tz offset — tsk's timestamp shape. */
    iso: string;
    /** The line's post-image at this commit (the hunk's `+` line, without the `+`). */
    line: string;
}

/**
 * Parse `git log --reverse -L<n>,<n>:<file> --format='COMMIT %H %aI'` output
 * into per-commit entries, oldest first. Each commit block contributes its
 * LAST `+` line (the post-image of the single-line range); `+++`/`---` file
 * headers are excluded. A block with no `+` line (e.g. the commit that
 * deletes the line) is skipped — the surviving entries still order correctly.
 */
export function parseGitLogL(output: string): GitLineEntry[] {
    const entries: GitLineEntry[] = [];
    let current: GitLineEntry | undefined;
    for (const raw of output.split('\n')) {
        if (raw.startsWith(COMMIT_PREFIX)) {
            const [hash, iso] = raw.slice(COMMIT_PREFIX.length).split(' ');
            if (hash && iso) {
                current = { hash, iso, line: '' };
                entries.push(current);
            }
            continue;
        }
        if (!current) continue;
        if (raw.startsWith('+') && !raw.startsWith('+++')) {
            current.line = raw.slice(1);
        }
    }
    return entries.filter((e) => e.line !== '');
}

/**
 * Derive the migration stamps from a line's history: `created` = the first
 * commit that introduced the line; `status` = the **most recent transition
 * into the final glyph** (done → reopened → done stamps the second done). A
 * line born with its current marker stamps `status = created`. Returns
 * `undefined` for an empty history (caller falls back to `now`). The status
 * value is always derived; `migrateMdLine` ignores it for `todo`/`notes`.
 */
export function deriveStamps(
    entries: readonly GitLineEntry[],
    map: ReadonlyMap<string, Marker>,
): MdStamps | undefined {
    const first = entries[0];
    if (!first) return undefined;
    const glyphOf = (line: string): string | undefined => matchMdTask(line, map)?.glyph;

    const finalGlyph = glyphOf((entries[entries.length - 1] as GitLineEntry).line);
    if (finalGlyph === undefined) return { created: first.iso };

    // Walk back to the start of the final run of the current glyph.
    let transition = entries.length - 1;
    while (
        transition > 0 &&
        glyphOf((entries[transition - 1] as GitLineEntry).line) === finalGlyph
    ) {
        transition--;
    }
    return { created: first.iso, status: (entries[transition] as GitLineEntry).iso };
}

/**
 * Map each doc line to its line number in HEAD's version of the file, by
 * exact-content greedy MONOTONIC matching (each head line consumed once, in
 * order — so duplicate content resolves positionally). `null` = no match
 * (a new/edited-since-HEAD line → the caller stamps `now` instead of asking
 * git about a line number that means something else). Needed because `-L`
 * addresses HEAD's line numbers, not the (possibly dirty) editor buffer's.
 */
export function mapDocLinesToHead(
    docLines: readonly string[],
    headLines: readonly string[],
): Array<number | null> {
    const result: Array<number | null> = [];
    let cursor = 0;
    for (const line of docLines) {
        let found: number | null = null;
        for (let i = cursor; i < headLines.length; i++) {
            if (headLines[i] === line) {
                found = i;
                cursor = i + 1;
                break;
            }
        }
        result.push(found);
    }
    return result;
}

// ── thin git runner (the only non-pure part) ────────────────────────────────

/**
 * HEAD's version of the file as lines, or `null` when git/repo/file isn't
 * available (untracked file, not a repo, git missing — every fallback case).
 * `HEAD:./<name>` keeps the path cwd-relative under `-C` (a bare
 * `HEAD:<name>` would resolve from the repo root).
 */
export async function gitShowHead(fileDir: string, fileName: string): Promise<string[] | null> {
    const out = await runGit(fileDir, ['show', `HEAD:./${fileName}`]);
    return out === null ? null : out.split(/\r?\n/);
}

/**
 * The full `-L` history for one HEAD line (1-based), oldest first, or `null`
 * on any git failure. One subprocess per task line — accuracy over speed for
 * a one-time migration (chunking is a deferred optimization).
 */
export async function gitLineHistory(
    fileDir: string,
    fileName: string,
    headLine: number,
): Promise<GitLineEntry[] | null> {
    const out = await runGit(fileDir, [
        'log',
        '--reverse',
        `-L${headLine},${headLine}:${fileName}`,
        `--format=${COMMIT_PREFIX}%H %aI`,
    ]);
    return out === null ? null : parseGitLogL(out);
}

async function runGit(cwd: string, args: string[]): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER });
        return stdout;
    } catch {
        return null;
    }
}
