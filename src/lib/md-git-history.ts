/**
 * Git-history derivation for the Markdown→tsk migration: for the md task
 * lines of one file, reconstruct WHEN each was added (`@created`) and when it
 * last entered its current marker (`@completed` / `@cancelled` / `@moved` /
 * `@started`) — from ONE streamed `git log --follow -p` pass per file.
 *
 * Why not blame: blame gives only the LAST touch — wrong for `@created` once
 * a line was reworded or flipped. Why not per-line `git log -L` (the first
 * cut): `-L` re-walks the entire history per task line (quadratic on deep,
 * auto-committed repos) and its output is unbounded — a commit rewriting the
 * region around a tracked line emits the whole overlapping hunk, which blew
 * `execFile`'s buffer on real histories.
 *
 * Instead: spawn `git log --follow -p -U0` (newest→oldest, git's native
 * order — which also avoids the known `--follow --reverse` quirks), parse the
 * patch stream incrementally (no output buffering), and replay it BACKWARD
 * with a per-line tracker. A touch whose pre-image glyph differs from the
 * final glyph is the status stamp (the most recent transition INTO the
 * current marker — done → reopened → done stamps the second done); an
 * insertion with no pre-image is `@created`, resolving the line. When every
 * queried line is resolved the subprocess is KILLED — the walk stops at the
 * oldest queried creation, not repo genesis.
 *
 * Split: pure parser + tracker (unit-tested on fixture patches) + thin
 * spawn/execFile runners at the bottom (node-only, no vscode — exercised
 * against a real scripted repo in the unit suite, like the SQLite stores).
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { Marker } from './markers';
import { type MdStamps, matchMdTask } from './md-migrate';

const execFileAsync = promisify(execFile);

/**
 * Sentinel prefixing each commit in our `git log` format string. `%x01`
 * (a control char no text line starts with) makes it collision-proof against
 * patch content — a content line inside a hunk always carries a `+`/`-`
 * prefix anyway.
 */
const COMMIT_SENTINEL = '\x01COMMIT ';
/** `git show HEAD:<file>` buffers one file's content — generous headroom. */
const GIT_SHOW_MAX_BUFFER = 64 * 1024 * 1024;

/** One hunk of a `-U0` patch (no context lines). */
export interface PatchHunk {
    /** 1-based start in the parent (pre-image); for `oldCount === 0`, the line BEFORE the insertion. */
    oldStart: number;
    oldCount: number;
    /** 1-based start in the child (post-image); for `newCount === 0`, the line BEFORE the deletion. */
    newStart: number;
    newCount: number;
    removed: string[];
    added: string[];
}

/** One commit of the streamed log: when, plus its hunks for the tracked file. */
export interface CommitPatch {
    hash: string;
    /** Author date, `%aI` strict ISO with the author's own tz offset — tsk's timestamp shape. */
    iso: string;
    hunks: PatchHunk[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Incremental parser for `git log -p -U0 --format=\x01COMMIT %H %aI` output.
 * Feed arbitrary chunks with {@link push} (a commit is emitted once the NEXT
 * sentinel arrives), then {@link end} to flush the final commit. Tolerates
 * partial lines across chunks, count-less hunk headers (`@@ -3 +3 @@`),
 * `\ No newline at end of file`, rename/mode headers, and signature noise —
 * anything that isn't a sentinel, hunk header, or hunk content resets the
 * current hunk. `---`/`+++` are headers only OUTSIDE a hunk; inside one,
 * `-`/`+` lines are content (even content that happens to be `--`).
 */
export class PatchStreamParser {
    private remainder = '';
    private current: CommitPatch | undefined;
    private hunk: PatchHunk | undefined;

    push(chunk: string): CommitPatch[] {
        const text = this.remainder + chunk;
        const lines = text.split('\n');
        this.remainder = lines.pop() ?? '';
        const completed: CommitPatch[] = [];
        for (const line of lines) this.feedLine(line, completed);
        return completed;
    }

    end(): CommitPatch[] {
        const completed: CommitPatch[] = [];
        if (this.remainder !== '') {
            this.feedLine(this.remainder, completed);
            this.remainder = '';
        }
        if (this.current) {
            completed.push(this.current);
            this.current = undefined;
            this.hunk = undefined;
        }
        return completed;
    }

    private feedLine(line: string, completed: CommitPatch[]): void {
        if (line.startsWith(COMMIT_SENTINEL)) {
            if (this.current) completed.push(this.current);
            const [hash, iso] = line.slice(COMMIT_SENTINEL.length).split(' ');
            this.current = hash && iso ? { hash, iso, hunks: [] } : undefined;
            this.hunk = undefined;
            return;
        }
        if (!this.current) return;
        const header = HUNK_HEADER_RE.exec(line);
        if (header) {
            this.hunk = {
                oldStart: Number(header[1]),
                oldCount: header[2] === undefined ? 1 : Number(header[2]),
                newStart: Number(header[3]),
                newCount: header[4] === undefined ? 1 : Number(header[4]),
                removed: [],
                added: [],
            };
            this.current.hunks.push(this.hunk);
            return;
        }
        if (this.hunk) {
            if (line.startsWith('-')) {
                this.hunk.removed.push(line.slice(1));
                return;
            }
            if (line.startsWith('+')) {
                this.hunk.added.push(line.slice(1));
                return;
            }
            if (line.startsWith('\\')) return; // "\ No newline at end of file"
        }
        this.hunk = undefined; // diff/index/rename headers, blank separators, …
    }
}

interface TrackedLine {
    /** The queried HEAD line number (1-based) — the result key. */
    headLine: number;
    /** The line's 1-based position at the revision the walk is currently at. */
    pos: number;
    /** The glyph the line carries at HEAD (under the md map); `undefined` → created-only result. */
    finalGlyph: string | undefined;
    /** Set once: the most recent transition INTO `finalGlyph`. */
    statusIso?: string;
    /** Resolved `@created` — the line is done. */
    createdIso?: string;
}

/**
 * Pure backward replay over {@link CommitPatch}es (newest first) for a set of
 * queried HEAD lines. Per commit, each unresolved line either: falls inside a
 * hunk's post-image range (a TOUCH — positional pairing against the hunk's
 * pre-image gives the older content; a pre-image glyph differing from the
 * final glyph locks the status stamp; no pre-image at that offset means the
 * commit INTRODUCED the line → `@created`, line resolved), or merely shifts
 * by the hunks above it. {@link done} flips when everything is resolved so
 * the caller can stop the stream early.
 */
export class LineHistoryTracker {
    private readonly lines: TrackedLine[];
    private resolvedCount = 0;

    constructor(
        headLines: readonly string[],
        queriedHeadLines: readonly number[],
        private readonly map: ReadonlyMap<string, Marker>,
    ) {
        this.lines = queriedHeadLines.map((n) => ({
            headLine: n,
            pos: n,
            finalGlyph: matchMdTask(headLines[n - 1] ?? '', map)?.glyph,
        }));
    }

    get done(): boolean {
        return this.resolvedCount === this.lines.length;
    }

    get progress(): { resolved: number; total: number } {
        return { resolved: this.resolvedCount, total: this.lines.length };
    }

    apply(commit: CommitPatch): void {
        if (commit.hunks.length === 0) return;
        for (const line of this.lines) {
            if (line.createdIso !== undefined) continue;
            this.applyToLine(line, commit);
        }
    }

    /** Stamps for every RESOLVED line, keyed by the queried HEAD line number. */
    results(): Map<number, MdStamps> {
        const out = new Map<number, MdStamps>();
        for (const line of this.lines) {
            if (line.createdIso === undefined) continue;
            out.set(
                line.headLine,
                line.finalGlyph === undefined
                    ? { created: line.createdIso }
                    : { created: line.createdIso, status: line.statusIso ?? line.createdIso },
            );
        }
        return out;
    }

    private applyToLine(line: TrackedLine, commit: CommitPatch): void {
        const touched = commit.hunks.find(
            (h) => h.newCount > 0 && line.pos >= h.newStart && line.pos < h.newStart + h.newCount,
        );
        if (!touched) {
            // Untouched — shift past the hunks that sit entirely above. A
            // zero-newCount (deletion) hunk's `newStart` is the line BEFORE the
            // deletion point, so its "first line after" is newStart + 1.
            let delta = 0;
            for (const h of commit.hunks) {
                const afterHunk = h.newCount === 0 ? h.newStart + 1 : h.newStart + h.newCount;
                if (afterHunk <= line.pos) delta += h.oldCount - h.newCount;
            }
            line.pos += delta;
            return;
        }

        const offset = line.pos - touched.newStart;
        const preImage = offset < touched.oldCount ? touched.removed[offset] : undefined;
        if (preImage === undefined) {
            // No pre-image at this offset — the commit introduced the line.
            line.createdIso = commit.iso;
            if (line.statusIso === undefined) line.statusIso = commit.iso; // born with its marker
            this.resolvedCount++;
            return;
        }
        // The line existed before, as `preImage`. A pre-glyph that differs
        // from the final glyph means THIS commit is the (newest) transition
        // into the current marker — lock the status stamp.
        if (line.statusIso === undefined && line.finalGlyph !== undefined) {
            const preGlyph = matchMdTask(preImage, this.map)?.glyph;
            if (preGlyph !== line.finalGlyph) line.statusIso = commit.iso;
        }
        line.pos = touched.oldStart + offset;
    }
}

/**
 * Map each doc line to its 0-BASED index into `headLines`, by exact-content
 * greedy MONOTONIC matching (each head line consumed once, in order — so
 * duplicate content resolves positionally); callers add 1 for the 1-based
 * HEAD line numbers the tracker speaks. `null` = no match
 * (a new/edited-since-HEAD line → the caller stamps `now` instead of asking
 * git about a line number that means something else). Needed because the
 * patch replay tracks HEAD's line numbers, not the (possibly dirty) editor
 * buffer's.
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

// ── thin git runners (the only non-pure part) ───────────────────────────────

/**
 * HEAD's version of the file as lines, or `null` when git/repo/file isn't
 * available (untracked file, not a repo, git missing — every fallback case).
 * `HEAD:./<name>` keeps the path relative to the subprocess working directory
 * (`fileDir`); a bare `HEAD:<name>` would resolve from the repo root.
 */
export async function gitShowHead(fileDir: string, fileName: string): Promise<string[] | null> {
    try {
        const { stdout } = await execFileAsync('git', ['show', `HEAD:./${fileName}`], {
            cwd: fileDir,
            maxBuffer: GIT_SHOW_MAX_BUFFER,
        });
        return stdout.split(/\r?\n/);
    } catch {
        return null;
    }
}

/** The result of one streamed derivation run. */
export interface FileLineStampsResult {
    /** Stamps for every line git could answer for, keyed by HEAD line number (1-based). */
    stamps: Map<number, MdStamps>;
    /** True when `isCancelled` fired — the caller applies nothing. */
    cancelled: boolean;
}

/**
 * Derive {@link MdStamps} for the queried HEAD lines of one file — ONE
 * spawned, stream-parsed `git log` per file, killed early once every line is
 * resolved (or on cancellation). Lines the history can't resolve (e.g. a
 * shallow-clone boundary) are simply absent from `stamps` — the caller's
 * `now` fallback covers them. Returns `null` only when git itself fails
 * before producing anything (not a repo, git missing).
 */
export function gitFileLineStamps(
    fileDir: string,
    fileName: string,
    headLines: readonly string[],
    queriedHeadLines: readonly number[],
    map: ReadonlyMap<string, Marker>,
    opts: {
        isCancelled?: () => boolean;
        /** Called per parsed commit with resolution progress. */
        onProgress?: (resolved: number, total: number, commits: number) => void;
    } = {},
): Promise<FileLineStampsResult | null> {
    if (queriedHeadLines.length === 0) {
        return Promise.resolve({ stamps: new Map(), cancelled: false });
    }
    const tracker = new LineHistoryTracker(headLines, queriedHeadLines, map);
    const parser = new PatchStreamParser();

    return new Promise((resolve) => {
        const child = spawn(
            'git',
            [
                '-c',
                'log.showSignature=false',
                'log',
                '--follow',
                '--no-color',
                '-p',
                '-U0',
                `--format=${COMMIT_SENTINEL}%H %aI`,
                '--',
                fileName,
            ],
            { cwd: fileDir, stdio: ['ignore', 'pipe', 'ignore'] },
        );

        let settled = false;
        let commits = 0;
        const finish = (result: FileLineStampsResult | null): void => {
            if (settled) return;
            settled = true;
            resolve(result);
        };

        const consume = (batch: CommitPatch[]): void => {
            for (const commit of batch) {
                if (opts.isCancelled?.()) {
                    child.kill();
                    finish({ stamps: new Map(), cancelled: true });
                    return;
                }
                tracker.apply(commit);
                commits++;
                const { resolved, total } = tracker.progress;
                opts.onProgress?.(resolved, total, commits);
                if (tracker.done) {
                    child.kill(); // early exit — everything resolved
                    finish({ stamps: tracker.results(), cancelled: false });
                    return;
                }
            }
        };

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => consume(parser.push(chunk)));
        child.on('error', () => finish(null)); // git not on PATH
        child.on('close', (code) => {
            consume(parser.end());
            if (settled) return;
            // History exhausted. A hard git failure with nothing parsed →
            // null (fallback); otherwise return what resolved (unresolved
            // lines fall back to `now` upstream).
            if (code !== 0 && commits === 0) finish(null);
            else finish({ stamps: tracker.results(), cancelled: false });
        });
    });
}
