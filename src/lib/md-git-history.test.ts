import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    type CommitPatch,
    gitFileLineStamps,
    gitShowHead,
    LineHistoryTracker,
    mapDocLinesToHead,
    PatchStreamParser,
} from './md-git-history';
import { DEFAULT_MD_MARKER_MAP, validateMarkerMap } from './md-migrate';

const MAP = validateMarkerMap(DEFAULT_MD_MARKER_MAP);

/** Format one commit block the way our `git log -p -U0 --format` emits it (newest first). */
const fmtCommit = (iso: string, hunkText: string): string =>
    `\x01COMMIT abcdef1234567890 ${iso}\n\ndiff --git a/t.md b/t.md\nindex 1111111..2222222 100644\n--- a/t.md\n+++ b/t.md\n${hunkText}`;

/** Parse a whole fixture in one push (+ end flush). */
const parseAll = (text: string): CommitPatch[] => {
    const parser = new PatchStreamParser();
    return [...parser.push(text), ...parser.end()];
};

// The flip-reflip history (newest→oldest): beta created [ ] at T1, done at T2,
// reopened at T3, done again at T4. HEAD: beta is line 3, currently [/].
const T1 = '2026-01-01T10:00:00+08:00';
const T2 = '2026-02-01T11:00:00+08:00';
const T3 = '2026-04-01T13:00:00+08:00';
const T4 = '2026-05-01T14:00:00+08:00';
const HEAD_LINES = ['# list', '- [ ] alpha', '- [/] beta', '- [ ] gamma', ''];
const FLIP_REFLIP = [
    fmtCommit(T4, '@@ -3,1 +3,1 @@\n-- [ ] beta\n+- [/] beta\n'),
    fmtCommit(T3, '@@ -3,1 +3,1 @@\n-- [/] beta\n+- [ ] beta\n'),
    fmtCommit(T2, '@@ -3,1 +3,1 @@\n-- [ ] beta\n+- [/] beta\n'),
    fmtCommit(T1, '@@ -0,0 +1,4 @@\n+# list\n+- [ ] alpha\n+- [ ] beta\n+- [ ] gamma\n'),
].join('');

describe('PatchStreamParser', () => {
    it('parses commits with hunks, newest first', () => {
        const commits = parseAll(FLIP_REFLIP);
        expect(commits.map((c) => c.iso)).toEqual([T4, T3, T2, T1]);
        expect(commits[0]?.hunks).toEqual([
            {
                oldStart: 3,
                oldCount: 1,
                newStart: 3,
                newCount: 1,
                removed: ['- [ ] beta'],
                added: ['- [/] beta'],
            },
        ]);
        expect(commits[3]?.hunks[0]).toMatchObject({ oldStart: 0, oldCount: 0, newCount: 4 });
    });

    it('is chunk-safe — feeding 5 bytes at a time parses identically', () => {
        const parser = new PatchStreamParser();
        const commits: CommitPatch[] = [];
        for (let i = 0; i < FLIP_REFLIP.length; i += 5) {
            commits.push(...parser.push(FLIP_REFLIP.slice(i, i + 5)));
        }
        commits.push(...parser.end());
        expect(commits).toEqual(parseAll(FLIP_REFLIP));
    });

    it('defaults omitted hunk counts to 1', () => {
        const commits = parseAll(fmtCommit(T1, '@@ -3 +3 @@\n-old\n+new\n'));
        expect(commits[0]?.hunks[0]).toMatchObject({ oldCount: 1, newCount: 1 });
    });

    it('treats "---" as content inside a hunk but as a header outside one', () => {
        const commits = parseAll(fmtCommit(T1, '@@ -1,1 +1,1 @@\n---\n+- [ ] x\n'));
        expect(commits[0]?.hunks[0]?.removed).toEqual(['--']);
        expect(commits[0]?.hunks[0]?.added).toEqual(['- [ ] x']);
    });

    it('ignores "\\ No newline" markers and tolerates header-only commits', () => {
        const text =
            fmtCommit(T2, '@@ -1,1 +1,1 @@\n-a\n+b\n\\ No newline at end of file\n') +
            `\x01COMMIT 999 ${T1}\n\n`;
        const commits = parseAll(text);
        expect(commits).toHaveLength(2);
        expect(commits[0]?.hunks[0]?.added).toEqual(['b']);
        expect(commits[1]?.hunks).toEqual([]);
    });
});

describe('LineHistoryTracker', () => {
    const replay = (
        headLines: readonly string[],
        queried: number[],
        fixture: string,
    ): LineHistoryTracker => {
        const tracker = new LineHistoryTracker(headLines, queried, MAP);
        for (const commit of parseAll(fixture)) tracker.apply(commit);
        return tracker;
    };

    it('flip-reflip: created = the intro commit, status = the LATEST transition into the glyph', () => {
        const tracker = replay(HEAD_LINES, [3], FLIP_REFLIP);
        expect(tracker.results().get(3)).toEqual({ created: T1, status: T4 });
        expect(tracker.done).toBe(true);
    });

    it('a task born with its marker stamps status = created', () => {
        const tracker = replay(HEAD_LINES, [2], FLIP_REFLIP); // alpha, untouched since T1
        expect(tracker.results().get(2)).toEqual({ created: T1, status: T1 });
    });

    it('a reword that keeps the glyph does not move the status (the run continues)', () => {
        const head = ['- [/] renamed task', ''];
        const fixture = [
            fmtCommit(T3, '@@ -1,1 +1,1 @@\n-- [/] old name\n+- [/] renamed task\n'),
            fmtCommit(T2, '@@ -1,1 +1,1 @@\n-- [ ] old name\n+- [/] old name\n'),
            fmtCommit(T1, '@@ -0,0 +1,1 @@\n+- [ ] old name\n'),
        ].join('');
        expect(replay(head, [1], fixture).results().get(1)).toEqual({ created: T1, status: T2 });
    });

    it('a line that became a task later: created = line birth, status = task-ification', () => {
        const head = ['- [/] now a task', ''];
        const fixture = [
            fmtCommit(T2, '@@ -1,1 +1,1 @@\n-just prose\n+- [/] now a task\n'),
            fmtCommit(T1, '@@ -0,0 +1,1 @@\n+just prose\n'),
        ].join('');
        expect(replay(head, [1], fixture).results().get(1)).toEqual({ created: T1, status: T2 });
    });

    it('shifts untouched lines past insertions and zero-count deletions above them', () => {
        // Insertion above: 2 lines added at the top in the newest commit.
        const headA = ['new1', 'new2', '- [/] task', ''];
        const fixtureA = [
            fmtCommit(T2, '@@ -0,0 +1,2 @@\n+new1\n+new2\n'),
            fmtCommit(T1, '@@ -0,0 +1,1 @@\n+- [/] task\n'),
        ].join('');
        expect(replay(headA, [3], fixtureA).results().get(3)).toEqual({ created: T1, status: T1 });

        // Deletion above: 2 lines that sat above were removed (zero-newCount hunk).
        const headB = ['- [/] keep', ''];
        const fixtureB = [
            fmtCommit(T2, '@@ -1,2 +0,0 @@\n-a\n-b\n'),
            fmtCommit(T1, '@@ -0,0 +1,3 @@\n+a\n+b\n+- [/] keep\n'),
        ].join('');
        expect(replay(headB, [1], fixtureB).results().get(1)).toEqual({ created: T1, status: T1 });
    });

    it('pairs lines positionally inside a multi-line hunk', () => {
        const head = ['- [x] A2', '- [/] B2', '- [ ] C2', ''];
        const fixture = [
            fmtCommit(
                T2,
                '@@ -1,3 +1,3 @@\n-- [x] A\n-- [ ] B\n-- [ ] C\n+- [x] A2\n+- [/] B2\n+- [ ] C2\n',
            ),
            fmtCommit(T1, '@@ -0,0 +1,3 @@\n+- [x] A\n+- [ ] B\n+- [ ] C\n'),
        ].join('');
        // B2 (line 2): the rewrite flipped its glyph ' '→'/' → status = T2.
        expect(replay(head, [2], fixture).results().get(2)).toEqual({ created: T1, status: T2 });
    });

    it('a queried non-task line yields created only (no status)', () => {
        const head = ['plain prose', ''];
        const fixture = fmtCommit(T1, '@@ -0,0 +1,1 @@\n+plain prose\n');
        expect(replay(head, [1], fixture).results().get(1)).toEqual({ created: T1 });
    });

    it('leaves a line unresolved (absent from results) when history never introduces it', () => {
        const tracker = replay(HEAD_LINES, [3], fmtCommit(T4, '@@ -3,1 +3,1 @@\n-x\n+y\n'));
        expect(tracker.done).toBe(false);
        expect(tracker.results().size).toBe(0);
    });

    it('flips done as soon as every queried line is resolved (the early-exit signal)', () => {
        const tracker = new LineHistoryTracker(HEAD_LINES, [2], MAP);
        const [newest, ...rest] = parseAll(FLIP_REFLIP);
        tracker.apply(newest as CommitPatch);
        expect(tracker.done).toBe(false); // alpha not introduced yet
        for (const commit of rest) tracker.apply(commit);
        expect(tracker.done).toBe(true);
    });
});

describe('mapDocLinesToHead', () => {
    it('maps an unchanged doc 1:1', () => {
        const lines = ['# t', '- [ ] a', '- [/] b'];
        expect(mapDocLinesToHead(lines, lines)).toEqual([0, 1, 2]);
    });

    it('maps around an inserted (uncommitted) line — the new line gets null', () => {
        const head = ['# t', '- [ ] a', '- [/] b'];
        const doc = ['# t', '- [ ] NEW', '- [ ] a', '- [/] b'];
        expect(mapDocLinesToHead(doc, head)).toEqual([0, null, 1, 2]);
    });

    it('an edited-since-HEAD line gets null (content no longer matches)', () => {
        const head = ['- [ ] a', '- [/] b'];
        const doc = ['- [ ] a edited', '- [/] b'];
        expect(mapDocLinesToHead(doc, head)).toEqual([null, 1]);
    });

    it('resolves duplicate content positionally (monotonic, each head line used once)', () => {
        const head = ['- [ ] dup', 'x', '- [ ] dup'];
        const doc = ['- [ ] dup', '- [ ] dup'];
        expect(mapDocLinesToHead(doc, head)).toEqual([0, 2]);
    });
});

describe('git runner (real scripted repo)', () => {
    let repo: string;

    const git = (args: string[], env?: Record<string, string>): void => {
        execFileSync('git', args, { cwd: repo, env: { ...process.env, ...env } });
    };
    const commit = (message: string, iso: string): void =>
        git(['commit', '-qm', message], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });

    beforeAll(() => {
        repo = mkdtempSync(join(tmpdir(), 'tsk-md-git-'));
        git(['init', '-q']);
        git(['config', 'user.name', 'test']);
        git(['config', 'user.email', 'test@test.local']);
        writeFileSync(join(repo, 'tasks.md'), '# list\n- [ ] alpha\n- [ ] beta\n');
        git(['add', 'tasks.md']);
        commit('add', T1);
        writeFileSync(join(repo, 'tasks.md'), '# list\n- [ ] alpha\n- [/] beta\n');
        git(['add', 'tasks.md']);
        commit('beta done', T2);
        git(['mv', 'tasks.md', 'notes.md']);
        commit('rename to notes', T3);
        writeFileSync(join(repo, 'untracked.md'), '- [ ] never committed\n');
    });

    afterAll(() => {
        rmSync(repo, { recursive: true, force: true });
    });

    it('derives created + flip status in ONE pass, following the rename', async () => {
        const head = await gitShowHead(repo, 'notes.md');
        expect(head?.[2]).toBe('- [/] beta');

        const run = await gitFileLineStamps(repo, 'notes.md', head as string[], [2, 3], MAP);
        expect(run?.cancelled).toBe(false);
        expect(run?.stamps.get(3)).toEqual({ created: T1, status: T2 }); // beta, through the rename
        expect(run?.stamps.get(2)).toEqual({ created: T1, status: T1 }); // alpha, born [ ]
    });

    it('honors cancellation and short-circuits empty queries', async () => {
        const head = (await gitShowHead(repo, 'notes.md')) as string[];
        const cancelled = await gitFileLineStamps(repo, 'notes.md', head, [3], MAP, {
            isCancelled: () => true,
        });
        expect(cancelled?.cancelled).toBe(true);
        expect(cancelled?.stamps.size).toBe(0);

        const empty = await gitFileLineStamps(repo, 'notes.md', head, [], MAP);
        expect(empty).toEqual({ stamps: new Map(), cancelled: false });
    });

    it('gitShowHead returns null for an untracked file and outside a repo', async () => {
        expect(await gitShowHead(repo, 'untracked.md')).toBeNull();
        expect(await gitShowHead(tmpdir(), 'nope.md')).toBeNull();
    });
});
