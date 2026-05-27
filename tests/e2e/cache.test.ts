import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';

/**
 * The fixture workspace is mounted via `.vscode-test.mjs`'s `workspaceFolder`,
 * and sets `tsk.cache.path: ""` so the cache opens in-memory — keeps test
 * runs hermetic (no on-disk artefacts) and exercises the resolver's empty-
 * setting → `IN_MEMORY` policy at the same time.
 *
 * `sample.tsk` in the fixture has four tasks with deterministic `@id`s.
 * Don't edit them — the assertions below pin specific values.
 */

suite('cache', () => {
    let api: TskExtensionApi;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();
    });

    test('initial scan indexes the fixture workspace', () => {
        const counts = api.counts();
        // sample.tsk (4 tasks) + dup.tsk (4 tasks, but one is a duplicate-id
        // that the cache skips → 3 inserted). Tags only come from sample.tsk.
        assert.strictEqual(counts.files, 2, 'expected two fixture files scanned');
        assert.strictEqual(counts.tasks, 7, 'expected seven tasks indexed');
        assert.ok(counts.tags >= 3, `expected at least three tags, got ${counts.tags}`);
    });

    test('lookupById finds each fixture task by its @id', () => {
        for (const id of ['m3task1', 'm3task2', 'm3task3', 'm3task4']) {
            const task = api.findTaskById(id);
            assert.ok(task, `expected to find task with @id=${id}`);
            assert.match(
                task.fileUri,
                /sample\.tsk$/,
                `task ${id} should live in the fixture's sample.tsk`,
            );
        }
    });

    test('listAllTags returns the tags from the fixture (sorted, distinct)', () => {
        const tags = api.listAllTags();
        assert.ok(tags.includes('project/tsk'));
        assert.ok(tags.includes('milestone/M3'));
        assert.ok(tags.includes('only-here'));
        // sorted, no dupes
        assert.deepStrictEqual([...tags].sort(), tags);
        assert.strictEqual(new Set(tags).size, tags.length);
    });

    test('tsk.rebuildCache reruns the scan and leaves counts unchanged', async () => {
        const before = api.counts();
        await vscode.commands.executeCommand('tsk.rebuildCache');
        const after = api.counts();
        assert.deepStrictEqual(after, before);
        // The fixture tasks should still be discoverable.
        assert.ok(api.findTaskById('m3task1'));
    });
});
