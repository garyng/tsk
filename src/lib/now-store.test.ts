import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NowStore, type NowStoreDeps } from './now-store';

/** Deterministic ids (`e1`, `e2`, …) + a fixed timestamp. */
function deterministicDeps(): NowStoreDeps {
    let n = 0;
    return { generateId: () => `e${++n}`, now: () => 'm' };
}

describe('NowStore (in-memory)', () => {
    let store: NowStore;

    beforeEach(() => {
        store = new NowStore(':memory:', { deps: deterministicDeps() });
    });

    afterEach(() => {
        store.dispose();
    });

    it('starts empty', () => {
        expect(store.getState()).toEqual({ version: 1, entries: [], currentEntryId: null });
        expect(store.getCurrentNowId()).toBeNull();
    });

    it('markNow appends a node, advances current, and fires onDidChange', () => {
        const changed = vi.fn();
        store.onDidChange(changed);
        store.markNow('task-a');
        expect(store.getState().entries).toHaveLength(1);
        expect(store.getState().entries[0]).toMatchObject({ entryId: 'e1', id: 'task-a' });
        expect(store.getCurrentNowId()).toBe('task-a');
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it('leaves in-memory state unchanged when a persist fails (A7)', () => {
        const s = new NowStore(':memory:', { deps: deterministicDeps() });
        s.markNow('task-a'); // e1 — persisted fine
        const before = s.getState();
        s.dispose(); // closes the db → the next persist() will throw
        expect(() => s.markNow('task-b')).toThrow();
        expect(s.getState()).toEqual(before); // no advanced-but-unpersisted node
    });

    it('delegates to the reducers (mark → branch → switch)', () => {
        store.markNow('task-a'); // e1 root
        store.markNow('task-b'); // e2 child of e1
        store.switchTo('e1');
        store.markNow('task-c'); // e3 child of e1 (a branch — e2 kept)
        const s = store.getState();
        expect(s.entries.map((e) => e.entryId)).toEqual(['e1', 'e2', 'e3']);
        expect(s.entries.find((e) => e.entryId === 'e3')?.parentId).toBe('e1');
        expect(s.currentEntryId).toBe('e3');
    });

    it('bump lifts an entry to the top, healing the gap, without a new node', () => {
        store.markNow('task-a'); // e1 root
        store.markNow('task-b'); // e2 child of e1
        store.markNow('task-c'); // e3 child of e2 (current e3)
        store.bump('e2'); // e2 → top (current); on-path child e3 takes e2's slot
        const s = store.getState();
        expect(s.currentEntryId).toBe('e2');
        expect(s.entries.find((e) => e.entryId === 'e2')?.parentId).toBe('e3'); // grafted under old current
        expect(s.entries.find((e) => e.entryId === 'e3')?.parentId).toBe('e1'); // e3 inherits e2's slot
        expect(s.entries.map((e) => e.entryId)).toEqual(['e1', 'e2', 'e3']); // no new node
    });

    it('exposes every destructive reducer as a persisted mutator', () => {
        store.markNow('task-a'); // e1 root
        store.markNow('task-b'); // e2 under e1
        store.markNow('task-c'); // e3 under e2
        store.pruneChildren('e2'); // drop e3
        expect(store.getState().entries.map((e) => e.entryId)).toEqual(['e1', 'e2']);

        store.removeEntry('e1'); // e2 becomes a root
        expect(store.getState().entries.find((e) => e.entryId === 'e2')?.parentId).toBeNull();

        store.markNow('task-d'); // e4 under e2
        store.pruneSubtree('e2'); // drop e2 + e4 → empty
        expect(store.getState().entries).toHaveLength(0);

        store.markNow('task-e'); // e5 root
        store.markNow('task-f'); // e6 under e5
        store.switchTo('e5');
        store.markNow('task-g'); // e7 under e5 (branch)
        store.switchTo('e6');
        store.pruneOffPath(); // keep e5 → e6
        expect(
            store
                .getState()
                .entries.map((e) => e.entryId)
                .sort(),
        ).toEqual(['e5', 'e6']);
    });

    it('does not fire onDidChange for a reducer no-op', () => {
        store.markNow('task-a');
        const changed = vi.fn();
        store.onDidChange(changed);
        store.switchTo('ghost'); // unknown → same-state no-op
        store.switchTo('e1'); // already current → no-op
        expect(changed).not.toHaveBeenCalled();
    });

    it('clear is a no-op (no emit) on an empty tree but empties a populated one', () => {
        const onEmpty = vi.fn();
        store.onDidChange(onEmpty);
        store.clear();
        expect(onEmpty).not.toHaveBeenCalled();

        store.markNow('task-a');
        const changed = vi.fn();
        store.onDidChange(changed);
        store.clear();
        expect(store.getState().entries).toHaveLength(0);
        expect(store.getCurrentNowId()).toBeNull();
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it('onDidChange returns a disposable that unsubscribes', () => {
        const changed = vi.fn();
        const sub = store.onDidChange(changed);
        sub.dispose();
        store.markNow('task-a');
        expect(changed).not.toHaveBeenCalled();
    });
});

describe('NowStore (persistence)', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), 'tsk-now-store-'));
    });

    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('round-trips the whole tree (incl. content + current) across a reopen', () => {
        const file = join(tmp, 'state.db');
        const first = new NowStore(file, { deps: deterministicDeps() });
        first.markNow('task-a'); // e1
        first.markNow('task-b', 'snapshot'); // e2 with content
        first.switchTo('e1');
        first.markNow('task-c'); // e3 — branch off e1
        const before = first.getState();
        first.dispose();

        const reopened = new NowStore(file);
        expect(reopened.getState()).toEqual(before);
        expect(reopened.getState().entries.find((e) => e.entryId === 'e2')?.content).toBe(
            'snapshot',
        );
        expect(reopened.getCurrentNowId()).toBe('task-c');
        reopened.dispose();
    });

    it('discards a hand-corrupted state.db to empty and warns on load', () => {
        const file = join(tmp, 'corrupt.db');
        // Seed a structurally-broken row (parent_id points at a non-existent entry).
        const raw = new DatabaseSync(file);
        raw.exec(
            `CREATE TABLE now_entry (entry_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
                marked_at TEXT NOT NULL, parent_id TEXT, created_seq INTEGER NOT NULL, content TEXT);
             CREATE TABLE now_meta (key TEXT PRIMARY KEY, value TEXT);`,
        );
        raw.prepare(
            `INSERT INTO now_entry (entry_id, task_id, marked_at, parent_id, created_seq, content)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run('a', 't', 'm', 'ghost', 0, null);
        raw.close();

        const warn = vi.fn();
        const store = new NowStore(file, { warn });
        expect(store.getState().entries).toHaveLength(0);
        expect(warn).toHaveBeenCalledOnce();
        store.dispose();
    });

    it('discards a state.db written by a different schema version (A5) and warns', () => {
        const file = join(tmp, 'versioned.db');
        const first = new NowStore(file, { deps: deterministicDeps() });
        first.markNow('task-a');
        first.dispose();

        // Simulate a future / foreign schema: bump user_version on disk.
        const raw = new DatabaseSync(file);
        raw.exec('PRAGMA user_version = 999');
        raw.close();

        const warn = vi.fn();
        const reopened = new NowStore(file, { warn });
        expect(reopened.getState().entries).toHaveLength(0); // discarded, not misread
        expect(warn).toHaveBeenCalledOnce();
        reopened.dispose();

        // The discard cleared the rows AND restamped user_version, so a fresh
        // reopen is cleanly empty with no re-warn (version now matches).
        const warn2 = vi.fn();
        const again = new NowStore(file, { warn: warn2 });
        expect(again.getState().entries).toHaveLength(0);
        expect(warn2).not.toHaveBeenCalled();
        again.dispose();
    });
});
