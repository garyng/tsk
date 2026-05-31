import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Graph layer e2e. The fixture's `dup.tsk` has two duplicate-id tasks
 * (`e2e-dup`) and a parent→child edge (`e2e-graph-parent` →
 * `e2e-graph-child`). The pure GraphService logic is covered exhaustively
 * in `src/lib/graph-service.test.ts`; this suite verifies that the
 * activation layer is wiring cache rescans → graph.applyFileTasks →
 * DiagnosticsManager correctly.
 */
suite('graph', () => {
    let api: TskExtensionApi;
    let dupUri: vscode.Uri;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();

        const firstFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(firstFolder, 'expected a workspace folder');
        dupUri = vscode.Uri.joinPath(firstFolder.uri, 'dup.tsk');
    });

    test('initial scan populates forward and inverse edges in the graph', () => {
        const parent = api.lookupGraph('e2e-graph-parent');
        assert.ok(parent, 'parent node should exist');
        assert.deepStrictEqual(parent.inverse.children, ['e2e-graph-child']);
        assert.deepStrictEqual(parent.forward, {});

        const child = api.lookupGraph('e2e-graph-child');
        assert.ok(child, 'child node should exist');
        assert.strictEqual(child.forward.parent, 'e2e-graph-parent');
        assert.deepStrictEqual(child.inverse, { children: [], dependents: [], related: [] });
    });

    test('lookupGraph returns undefined for an unknown id', () => {
        assert.strictEqual(api.lookupGraph('never-existed-anywhere'), undefined);
    });

    test('duplicate @id occurrences produce diagnostics on every occurrence', async () => {
        // Ensure the dup.tsk doc is in the diagnostics collection by opening
        // it (some VSCode versions lazily populate diagnostics for unopened
        // files until the first explicit query).
        const doc = await vscode.workspace.openTextDocument(dupUri);
        await vscode.window.showTextDocument(doc);
        await new Promise((resolve) => setImmediate(resolve));

        const diagnostics = vscode.languages.getDiagnostics(dupUri);
        // Two `e2e-dup` occurrences → two diagnostics with the dup-id message.
        const dupDiagnostics = diagnostics.filter((d) => /Duplicate @id "e2e-dup"/.test(d.message));
        assert.strictEqual(
            dupDiagnostics.length,
            2,
            `expected 2 dup-id diagnostics in dup.tsk, got ${dupDiagnostics.length}: ${JSON.stringify(dupDiagnostics.map((d) => d.message))}`,
        );
        // One diagnostic should announce the canonical occurrence, the other
        // should defer to it.
        const canonicalCount = dupDiagnostics.filter((d) =>
            /canonical occurrence/.test(d.message),
        ).length;
        const deferringCount = dupDiagnostics.filter((d) =>
            /takes precedence/.test(d.message),
        ).length;
        assert.strictEqual(canonicalCount, 1, 'one diagnostic should mark the canonical');
        assert.strictEqual(deferringCount, 1, 'one diagnostic should defer to the canonical');
    });

    test('tsk.rebuildCache rebuilds the graph (forward and inverse edges return)', async () => {
        await vscode.commands.executeCommand('tsk.rebuildCache');
        const parent = api.lookupGraph('e2e-graph-parent');
        const child = api.lookupGraph('e2e-graph-child');
        assert.ok(parent && child, 'parent + child should still resolve after rebuild');
        assert.deepStrictEqual(parent.inverse.children, ['e2e-graph-child']);
        assert.strictEqual(child.forward.parent, 'e2e-graph-parent');
    });
});
