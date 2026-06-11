import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    deriveStamps,
    type GitLineEntry,
    gitLineHistory,
    gitShowHead,
    mapDocLinesToHead,
    parseGitLogL,
} from './md-git-history';
import { DEFAULT_MD_MARKER_MAP, validateMarkerMap } from './md-migrate';

const MAP = validateMarkerMap(DEFAULT_MD_MARKER_MAP);

/**
 * Captured verbatim from the M2 spike repo (see the plan): `git log --reverse
 * -L3,3:notes.md --format='COMMIT %H %aI'` on a line that went todo → done →
 * reopened → done again, across a file rename (tasks.md → notes.md — note the
 * rename commit itself does not appear; -L follows it silently).
 */
const BETA_FLIP_REFLIP = `COMMIT 185440dd55351b9f7b91781940234f449e66ef20 2026-01-01T10:00:00+08:00

diff --git a/tasks.md b/tasks.md
new file mode 100644
index 0000000..9c26177
--- /dev/null
+++ b/tasks.md
@@ -0,0 +3,1 @@
+- [ ] beta
COMMIT 6857c7f823aa828b4c1f025c05b053485feb0ba9 2026-02-01T11:00:00+08:00

diff --git a/tasks.md b/tasks.md
index 9c26177..abd8b6e 100644
--- a/tasks.md
+++ b/tasks.md
@@ -3,1 +3,1 @@
-- [ ] beta
+- [/] beta
COMMIT 17d78b92de558871dd54a4d4711a344eadc2c9fd 2026-04-01T13:00:00+08:00

diff --git a/tasks.md b/tasks.md
index fd1f9aa..90437a0 100644
--- a/tasks.md
+++ b/tasks.md
@@ -3,1 +3,1 @@
-- [/] beta
+- [ ] beta
COMMIT 2eace1cc64d72dd45fa9c9568be79746d16b0877 2026-05-01T14:00:00+08:00

diff --git a/tasks.md b/tasks.md
index 90437a0..87217eb 100644
--- a/tasks.md
+++ b/tasks.md
@@ -3,1 +3,1 @@
-- [ ] beta
+- [/] beta
`;

/** Same capture for a line that was only reworded (todo throughout). */
const GAMMA_REWORD = `COMMIT 185440dd55351b9f7b91781940234f449e66ef20 2026-01-01T10:00:00+08:00

diff --git a/tasks.md b/tasks.md
new file mode 100644
index 0000000..9c26177
--- /dev/null
+++ b/tasks.md
@@ -0,0 +4,1 @@
+- [ ] gamma
COMMIT 6b3379b368b319e48b639408db1b6b72a1a2a6fb 2026-03-01T12:00:00+08:00

diff --git a/tasks.md b/tasks.md
index abd8b6e..fd1f9aa 100644
--- a/tasks.md
+++ b/tasks.md
@@ -4,1 +4,1 @@
-- [ ] gamma
+- [ ] gamma rewritten
`;

describe('parseGitLogL', () => {
    it('parses the flip-reflip capture into oldest-first post-image entries', () => {
        const entries = parseGitLogL(BETA_FLIP_REFLIP);
        expect(entries.map((e) => [e.iso, e.line])).toEqual([
            ['2026-01-01T10:00:00+08:00', '- [ ] beta'],
            ['2026-02-01T11:00:00+08:00', '- [/] beta'],
            ['2026-04-01T13:00:00+08:00', '- [ ] beta'],
            ['2026-05-01T14:00:00+08:00', '- [/] beta'],
        ]);
        expect(entries[0]?.hash).toBe('185440dd55351b9f7b91781940234f449e66ef20');
    });

    it('parses the reword capture and never mistakes a "+++" file header for content', () => {
        const entries = parseGitLogL(GAMMA_REWORD);
        expect(entries.map((e) => e.line)).toEqual(['- [ ] gamma', '- [ ] gamma rewritten']);
        expect(entries.some((e) => e.line.startsWith('++'))).toBe(false);
    });

    it('returns [] for empty output', () => {
        expect(parseGitLogL('')).toEqual([]);
    });
});

describe('deriveStamps', () => {
    const entry = (iso: string, line: string): GitLineEntry => ({ hash: 'h', iso, line });

    it('flip-reflip: created = first commit, status = the LATEST transition into the current glyph', () => {
        expect(deriveStamps(parseGitLogL(BETA_FLIP_REFLIP), MAP)).toEqual({
            created: '2026-01-01T10:00:00+08:00',
            status: '2026-05-01T14:00:00+08:00',
        });
    });

    it('reword without a flip: status stays at creation (no transition happened)', () => {
        expect(deriveStamps(parseGitLogL(GAMMA_REWORD), MAP)).toEqual({
            created: '2026-01-01T10:00:00+08:00',
            status: '2026-01-01T10:00:00+08:00',
        });
    });

    it('a task born with its current marker stamps status = created', () => {
        expect(deriveStamps([entry('t1', '- [x] born cancelled')], MAP)).toEqual({
            created: 't1',
            status: 't1',
        });
    });

    it('a line that became a task later: created = line birth, status = when it became the task', () => {
        const entries = [
            entry('t1', 'just prose'),
            entry('t2', '- [/] now a done task'),
            entry('t3', '- [/] now a done task, reworded'),
        ];
        expect(deriveStamps(entries, MAP)).toEqual({ created: 't1', status: 't2' });
    });

    it('a final line that is not a task yields created only', () => {
        expect(deriveStamps([entry('t1', 'prose then'), entry('t2', 'prose now')], MAP)).toEqual({
            created: 't1',
        });
    });

    it('returns undefined for an empty history', () => {
        expect(deriveStamps([], MAP)).toBeUndefined();
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
        commit('add', '2026-01-01T10:00:00+08:00');
        writeFileSync(join(repo, 'tasks.md'), '# list\n- [ ] alpha\n- [/] beta\n');
        git(['add', 'tasks.md']);
        commit('beta done', '2026-02-01T11:00:00+08:00');
        writeFileSync(join(repo, 'untracked.md'), '- [ ] never committed\n');
    });

    afterAll(() => {
        rmSync(repo, { recursive: true, force: true });
    });

    it('gitShowHead returns HEAD lines; gitLineHistory replays a flip with %aI dates', async () => {
        const head = await gitShowHead(repo, 'tasks.md');
        expect(head?.[2]).toBe('- [/] beta');

        const entries = await gitLineHistory(repo, 'tasks.md', 3);
        expect(entries?.map((e) => [e.iso, e.line])).toEqual([
            ['2026-01-01T10:00:00+08:00', '- [ ] beta'],
            ['2026-02-01T11:00:00+08:00', '- [/] beta'],
        ]);
        expect(deriveStamps(entries ?? [], MAP)).toEqual({
            created: '2026-01-01T10:00:00+08:00',
            status: '2026-02-01T11:00:00+08:00',
        });
    });

    it('returns null for an untracked file and outside a repo', async () => {
        expect(await gitShowHead(repo, 'untracked.md')).toBeNull();
        expect(await gitLineHistory(repo, 'untracked.md', 1)).toBeNull();
        expect(await gitShowHead(tmpdir(), 'nope.md')).toBeNull();
    });
});
