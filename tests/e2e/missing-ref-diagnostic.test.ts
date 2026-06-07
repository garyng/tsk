import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Missing-reference diagnostic e2e (M20/B). Verifies that broken
 * forward edges (parent / dependsOn / relatedTo pointing at non-
 * existent task ids) surface as Warning-level diagnostics on the
 * source line.
 *
 * Fixture: `broken-ref.tsk` in the workspace, each task carries at
 * least one ghost id. Tests assert the squiggle's severity, message
 * shape, and the `broken-ref:<key>` code that the M20/C code action
 * will match against.
 */
suite('missing-reference diagnostics', () => {
    let brokenRefUri: vscode.Uri;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'expected a workspace folder');
        brokenRefUri = vscode.Uri.joinPath(folder.uri, 'broken-ref.tsk');
        // Make sure the file is parsed + indexed before assertions land.
        const doc = await vscode.workspace.openTextDocument(brokenRefUri);
        await vscode.window.showTextDocument(doc);
        await new Promise((resolve) => setTimeout(resolve, 100));
    });

    function tskDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
        return vscode.languages
            .getDiagnostics(uri)
            .filter((d) => (typeof d.code === 'string' ? d.code.startsWith('broken-ref:') : false));
    }

    test('emits a broken-ref Warning for an orphan @parent', async () => {
        const ds = tskDiagnostics(brokenRefUri);
        const orphan = ds.find((d) => d.message.includes('m20-ghost-parent'));
        assert.ok(orphan, 'expected a diagnostic for m20-ghost-parent');
        assert.strictEqual(orphan.severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(orphan.code, 'broken-ref:parent');
        assert.match(
            orphan.message,
            /^Tsk: @parent references unknown task id "m20-ghost-parent"\.$/,
        );
    });

    test('emits a broken-ref Warning for an orphan @dependsOn', async () => {
        const ds = tskDiagnostics(brokenRefUri);
        const orphan = ds.find((d) => d.message.includes('m20-ghost-depends'));
        assert.ok(orphan, 'expected a diagnostic for m20-ghost-depends');
        assert.strictEqual(orphan.code, 'broken-ref:dependsOn');
    });

    test('emits one diagnostic per broken key on a triple-broken task', async () => {
        const ds = tskDiagnostics(brokenRefUri);
        // The triple-broken fixture task uses id-quoted targets — match on the
        // exact `"<id>"` form so we don't catch the orphan-parent /
        // orphan-depends rows' diagnostics by substring.
        const triple = ds.filter(
            (d) =>
                d.message.includes('"m20-ghost-p"') ||
                d.message.includes('"m20-ghost-d"') ||
                d.message.includes('"m20-ghost-r"'),
        );
        assert.strictEqual(
            triple.length,
            3,
            'expected 3 broken-ref diagnostics on the triple-broken row',
        );
        const codes = triple.map((d) => d.code).sort();
        assert.deepStrictEqual(codes, [
            'broken-ref:dependsOn',
            'broken-ref:parent',
            'broken-ref:relatedTo',
        ]);
    });

    test('does NOT emit broken-ref diagnostics for resolvable refs in dup.tsk', async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder);
        const dupUri = vscode.Uri.joinPath(folder.uri, 'dup.tsk');
        const ds = tskDiagnostics(dupUri);
        // dup.tsk's child task has @parent:e2e-graph-parent, which resolves
        // to a task in the same file. No broken-ref squiggle should appear.
        assert.strictEqual(ds.length, 0, 'expected zero broken-ref diagnostics in dup.tsk');
    });

    test('emits a broken-ref:movedTo Warning for a dangling @movedTo (M8)', async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder);
        const movedUri = vscode.Uri.joinPath(folder.uri, 'moved.tsk');
        const doc = await vscode.workspace.openTextDocument(movedUri);
        await vscode.window.showTextDocument(doc);
        await new Promise((resolve) => setTimeout(resolve, 100));

        const ds = tskDiagnostics(movedUri);
        const dangling = ds.find((d) => d.message.includes('e2e-moved-gone'));
        assert.ok(dangling, 'expected a broken-ref diagnostic for the dangling @movedTo');
        assert.strictEqual(dangling.severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(dangling.code, 'broken-ref:movedTo');
        assert.match(
            dangling.message,
            /^Tsk: @movedTo references unknown task id "e2e-moved-gone"\.$/,
        );
        // The resolvable move (e2e-moved-src -> e2e-moved-target) must NOT squiggle.
        assert.ok(
            !ds.some((d) => d.message.includes('e2e-moved-target')),
            'a resolvable @movedTo must not produce a diagnostic',
        );
    });
});
