import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';
const PRIORITY_OPACITY_KEY = 'decorations.priority.opacity';

/**
 * Decoration e2e suite. The fixture's `sample.tsk` is curated so its four
 * tasks exercise three markers (todo / inprogress / completed) and three
 * priorities (P1 / P2 / P3); see `tests/e2e/fixtures/workspace/sample.tsk`.
 *
 * VSCode doesn't expose what `setDecorations` actually rendered, so we
 * verify via `TskExtensionApi.getDecorations(uri)` — the snapshot the
 * activation layer records right after calling `setDecorations`.
 */
suite('decorations', () => {
    let api: TskExtensionApi;
    let sampleUri: vscode.Uri;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();

        const firstFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(firstFolder, 'expected a workspace folder');
        sampleUri = vscode.Uri.joinPath(firstFolder.uri, 'sample.tsk');

        // Open the doc and surface the editor so the active/visible handlers
        // fire and the snapshot gets populated.
        const doc = await vscode.workspace.openTextDocument(sampleUri);
        await vscode.window.showTextDocument(doc);
        // Yield once so onDidChangeActiveTextEditor's synchronous handler runs.
        await new Promise((resolve) => setImmediate(resolve));
    });

    test('marker snapshot reflects the markers used in the fixture', () => {
        const snapshot = api.getDecorations(sampleUri.toString());
        assert.ok(snapshot, 'snapshot should exist after opening sample.tsk');

        // Lines per the fixture (0-indexed): m3task1=5, m3task2=6, m3task3=7,
        // m3task4=8. The markdown header occupies lines 0..4.
        assert.deepStrictEqual(
            snapshot.markers.todo.map((r) => r.startLine),
            [5, 8],
        );
        assert.deepStrictEqual(
            snapshot.markers.inprogress.map((r) => r.startLine),
            [6],
        );
        assert.deepStrictEqual(
            snapshot.markers.completed.map((r) => r.startLine),
            [7],
        );

        // The other three markers don't appear in the fixture — snapshot
        // keeps them present but empty so stale decorations get cleared.
        assert.strictEqual(snapshot.markers.moved.length, 0);
        assert.strictEqual(snapshot.markers.cancelled.length, 0);
        assert.strictEqual(snapshot.markers.notes.length, 0);
    });

    test('priority snapshot reflects @priority metadata on the right lines', () => {
        const snapshot = api.getDecorations(sampleUri.toString());
        assert.ok(snapshot);

        assert.deepStrictEqual(
            snapshot.priorities[1].map((r) => r.startLine),
            [5],
        );
        assert.deepStrictEqual(
            snapshot.priorities[2].map((r) => r.startLine),
            [6],
        );
        assert.deepStrictEqual(
            snapshot.priorities[3].map((r) => r.startLine),
            [7],
        );
    });

    test('metadata snapshot covers the <!-- ... --> block on every task that has one', () => {
        const snapshot = api.getDecorations(sampleUri.toString());
        assert.ok(snapshot);
        // All four fixture tasks carry inline metadata (lines 5-8).
        assert.deepStrictEqual(snapshot.metadata.map((r) => r.startLine).sort(), [5, 6, 7, 8]);
    });

    test('flipping tsk.decorations.priority.opacity stays consistent', async () => {
        const config = () => vscode.workspace.getConfiguration('tsk');
        // Use inspect() so we restore the *workspace-layer* value specifically
        // — `get()` would return the resolved default (0.15), which would then
        // get written back as an explicit workspace setting and pollute the
        // fixture's settings.json. `undefined` here means "no workspace-layer
        // override", which is what the fixture starts with.
        const originalWorkspace = config().inspect<number>(PRIORITY_OPACITY_KEY)?.workspaceValue;
        try {
            await config().update(PRIORITY_OPACITY_KEY, 0.5, vscode.ConfigurationTarget.Workspace);
            // The setting-change handler runs synchronously inside the
            // onDidChangeConfiguration event; yield once so it lands before
            // we re-read the snapshot.
            await new Promise((resolve) => setImmediate(resolve));

            assert.strictEqual(
                config().get<number>(PRIORITY_OPACITY_KEY),
                0.5,
                'setting should reflect the updated value',
            );

            const snapshot = api.getDecorations(sampleUri.toString());
            assert.ok(snapshot, 'snapshot still exists after opacity flip');
            // Priority *ranges* don't depend on opacity (only the runtime
            // DecorationType's background string does), so the bucket
            // structure is unchanged.
            assert.strictEqual(snapshot.priorities[1].length, 1);
            assert.strictEqual(snapshot.priorities[2].length, 1);
            assert.strictEqual(snapshot.priorities[3].length, 1);
        } finally {
            await config().update(
                PRIORITY_OPACITY_KEY,
                originalWorkspace,
                vscode.ConfigurationTarget.Workspace,
            );
        }
    });

    test('getDecorations returns undefined for an unknown URI', () => {
        assert.strictEqual(api.getDecorations('file:///nope-never-touched.tsk'), undefined);
    });
});
