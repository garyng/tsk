import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Untitled-buffer e2e (M18). Validates the "local-only features"
 * contract: decorations, codelens forward-resolve, toggles, completion,
 * and Enter/Tab semantics all work on `untitled:` URIs, while the cache
 * stays empty and inverse-edge codelens / find-by-tag don't surface the
 * untitled buffer (acceptable per scope).
 *
 * Cross-file references to *existing* workspace tasks are exercised
 * against the `dup.tsk` fixture (parent id `e2e-graph-parent`).
 */
suite('untitled buffers — local-only features', () => {
    let api: TskExtensionApi;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();
    });

    async function openUntitled(content: string): Promise<vscode.TextDocument> {
        const doc = await vscode.workspace.openTextDocument({ content, language: 'tsk' });
        await vscode.window.showTextDocument(doc);
        // Yield so onDidChangeActiveTextEditor handlers (decoration apply,
        // debounce reset) get a chance to run before we assert.
        await new Promise((resolve) => setImmediate(resolve));
        return doc;
    }

    test('decoration snapshot is non-empty for an untitled `.tsk` buffer', async () => {
        // @priority gives the buffer a decoration to assert on: markers + metadata
        // are now semantic tokens (M41), leaving the priority line background as
        // the only `.tsk` decoration. (Untitled marker/metadata tokens are covered
        // in semantic-tokens.test.ts.)
        const doc = await openUntitled('- [ ] decorate me <!-- @id:u1 @priority:1 -->');
        // Decorations fire on `onDidChangeActiveTextEditor`. Give them a
        // moment to land before reading the snapshot.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const snap = api.getDecorations(doc.uri.toString());
        assert.ok(snap, 'expected a decoration snapshot for the untitled buffer');
        assert.ok(snap.priorities[1].length > 0, 'expected the @priority:1 decoration range');
    });

    test('Alt+A on an untitled blank line wraps it into a fresh task', async () => {
        const doc = await openUntitled('');
        const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
        assert.ok(editor, 'editor for untitled doc should be visible');
        editor.selections = [new vscode.Selection(0, 0, 0, 0)];
        await new Promise((resolve) => setImmediate(resolve));
        await vscode.commands.executeCommand('tsk.toggleTodo');
        const text = doc.lineAt(0).text;
        assert.match(text, /^- \[ \] {2}<!-- @id:[a-z0-9]+ @created:[\d\-T:+]+ -->$/);
    });

    test('cache stays empty when an untitled buffer gains a task', async () => {
        const before = api.counts().tasks;
        const doc = await openUntitled('- [ ] not in cache <!-- @id:untitled-only -->');
        // Give the change listener a beat (in case some path tried to rescan).
        await new Promise((resolve) => setTimeout(resolve, 50));
        const after = api.counts().tasks;
        assert.strictEqual(after, before, 'cache count should not change for untitled buffers');
        // Sanity: parsed task is queryable via lookupById ONLY through cache,
        // so a missing entry confirms the cache really skipped it.
        assert.strictEqual(
            api.findTaskById('untitled-only'),
            undefined,
            'untitled task should not be queryable through the cache',
        );
        // Keep doc referenced so TS doesn't flag unused.
        assert.ok(doc.languageId === 'tsk');
    });

    test('tag completion fires on `#` in an untitled buffer', async () => {
        const doc = await openUntitled('- [ ] tag me #');
        const triggerPos = new vscode.Position(0, doc.lineAt(0).text.length);
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            triggerPos,
            '#',
        );
        assert.ok(list, 'completion provider should return a list');
        const labels = list.items.map((i) =>
            typeof i.label === 'string' ? i.label : i.label.label,
        );
        // Workspace fixture defines yaml-only-not-in-tsk; expect it to surface
        // through the untitled doc's completion provider.
        assert.ok(
            labels.includes('yaml-only-not-in-tsk'),
            `expected workspace tag in untitled-buffer completion; got ${labels.join(', ')}`,
        );
    });

    test('codelens does NOT render on untitled buffers (consistent with local-only scope)', async () => {
        // Codelens requires the source task to be a graph node (see
        // computeLensesForTask's canonical-occurrence gate). Untitled
        // tasks are excluded from the cache → graph, so their lenses
        // don't render — neither forward (goToParent) nor inverse
        // (findAllChildren). Cross-file refs are deliberately a
        // file-only feature.
        const doc = await openUntitled(
            '- [ ] untitled child <!-- @id:untitled-child @parent:e2e-graph-parent -->',
        );
        const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
            'vscode.executeCodeLensProvider',
            doc.uri,
        );
        // Provider may return undefined or an empty array depending on
        // VS Code's caching behavior; both mean "no lenses".
        const ours = (lenses ?? []).filter((l) => l.command?.command?.startsWith('tsk.'));
        assert.strictEqual(ours.length, 0, 'expected zero tsk codelenses on untitled buffer');
    });

    test('Enter continuation on an untitled buffer produces the M19/B cursor-spacer shape', async () => {
        const doc = await openUntitled('- [ ] x');
        const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
        assert.ok(editor);
        // Cursor at end of "- [ ] x" (col 7).
        editor.selection = new vscode.Selection(0, 7, 0, 7);
        await new Promise((resolve) => setImmediate(resolve));
        await vscode.commands.executeCommand('tsk.handleEnter');
        const lines = doc.getText().split('\n');
        assert.strictEqual(lines[0], '- [ ] x');
        assert.match(lines[1] ?? '', /^- \[ \] {2}<!-- @id:[a-z0-9]+ @created:[\d\-T:+]+ -->$/);
        // Cursor should land at column 6 (between the two spaces) on the
        // continuation line.
        assert.strictEqual(editor.selection.active.line, 1);
        assert.strictEqual(editor.selection.active.character, 6);
    });
});
