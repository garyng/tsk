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

    test('marker buckets are empty in the .tsk snapshot — markers moved to semantic tokens (M41)', () => {
        const snapshot = api.getDecorations(sampleUri.toString());
        assert.ok(snapshot, 'snapshot should exist after opening sample.tsk');

        // Markers are now colored by the semantic-tokens provider, not
        // decorations, so the decoration snapshot carries no marker ranges for
        // `.tsk`. Marker coloring is asserted in tests/e2e/semantic-tokens.test.ts.
        for (const status of [
            'todo',
            'inprogress',
            'completed',
            'moved',
            'cancelled',
            'notes',
        ] as const) {
            assert.strictEqual(
                snapshot.markers[status].length,
                0,
                `${status} bucket should be empty`,
            );
        }
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

    test('metadata bucket is empty in the .tsk snapshot — metadata moved to semantic tokens (M41)', () => {
        const snapshot = api.getDecorations(sampleUri.toString());
        assert.ok(snapshot);
        // Inline <!-- ... --> metadata is now dimmed via the semantic-tokens
        // provider, not a decoration — see tests/e2e/semantic-tokens.test.ts.
        assert.strictEqual(
            snapshot.metadata.length,
            0,
            'metadata decoration bucket should be empty',
        );
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

    test('closing an untitled `.tsk` buffer evicts its decoration snapshot (M31/A)', async () => {
        // Untitled buffers are the M18 leak: they never reach the on-disk
        // delete watcher (which evicts file-backed snapshots), but they DO fire
        // onDidCloseTextDocument reliably on close. revert-and-close discards
        // the unsaved content without a save prompt.
        const doc = await vscode.workspace.openTextDocument({
            content: '- [ ] gc me <!-- @id:gc1 -->',
            language: 'tsk',
        });
        await vscode.window.showTextDocument(doc);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const key = doc.uri.toString();
        assert.ok(api.getDecorations(key), 'snapshot should exist while the buffer is open');

        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        // onDidCloseTextDocument can lag the editor close by a tick — poll.
        for (let i = 0; i < 40 && api.getDecorations(key); i++) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.strictEqual(
            api.getDecorations(key),
            undefined,
            'snapshot should be evicted after the buffer is closed',
        );
    });
});
