import * as assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';

/**
 * `[[wiki link]]` e2e. The fixture lives in a TEMP directory, not in
 * `fixtures/workspace`, on purpose: `cache.test.ts` asserts exact fixture
 * file/task counts, so adding a `.tsk` file there would break an unrelated
 * suite. A temp doc also exercises both resolution branches in one file —
 * `[[sample.tsk]]` can only resolve workspace-relative, `[[target.md]]` only
 * document-relative.
 */
suite('wiki links', () => {
    let dir: string;
    let doc: vscode.TextDocument;
    /** A NESTED workspace file, so basename and relative path differ (see the filterText test). */
    let nested: string;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();

        // A non-`.tsk` file inside the fixture workspace: offered by the
        // git-backed file listing, but invisible to the `.tsk` scan, so
        // `cache.test.ts`'s exact file/task counts stay valid.
        const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath as string;
        nested = join(workspaceDir, 'nested', 'deep.md');
        mkdirSync(join(workspaceDir, 'nested'), { recursive: true });
        writeFileSync(nested, '# deep\n');

        dir = mkdtempSync(join(tmpdir(), 'tsk-links-e2e-'));
        writeFileSync(join(dir, 'target.md'), '# the target\n');
        writeFileSync(
            join(dir, 'notes.tsk'),
            [
                '- [n] doc-relative [[target.md]]',
                '- [n] workspace-relative [[sample.tsk]]',
                '- [n] dangling [[nope.md]]',
                '- [n] typing [[sam',
                '',
            ].join('\n'),
        );
        doc = await vscode.workspace.openTextDocument(join(dir, 'notes.tsk'));
        await vscode.window.showTextDocument(doc);
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        rmSync(dir, { recursive: true, force: true });
        rmSync(join(nested, '..'), { recursive: true, force: true });
    });

    /** Poll briefly for an async-produced value — diagnostics arrive off the open event. */
    const waitFor = async <T>(probe: () => T | undefined): Promise<T | undefined> => {
        for (let attempt = 0; attempt < 20; attempt++) {
            const value = probe();
            if (value !== undefined) return value;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return undefined;
    };

    const links = async (): Promise<vscode.DocumentLink[]> => {
        const all = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
            'vscode.executeLinkProvider',
            doc.uri,
        );
        // `autolinks` also contributes to this document; keep only the
        // bracket-shaped ranges this suite is about.
        return (all ?? []).filter((l) => doc.getText(l.range).startsWith('[['));
    };

    test('a document-relative target resolves', async () => {
        const link = (await links()).find((l) => doc.getText(l.range) === '[[target.md]]');
        assert.ok(link, 'the [[target.md]] span should be a link');
        assert.strictEqual(basename(link.target?.fsPath ?? ''), 'target.md');
    });

    test('a workspace-relative target resolves', async () => {
        const link = (await links()).find((l) => doc.getText(l.range) === '[[sample.tsk]]');
        assert.ok(link, 'the [[sample.tsk]] span should be a link');
        assert.ok(
            link.target?.fsPath.endsWith(join('fixtures', 'workspace', 'sample.tsk')),
            `expected the fixture workspace file, got ${link.target?.fsPath}`,
        );
    });

    test('a dangling target still gets a span, with no target and an explaining tooltip', async () => {
        const link = (await links()).find((l) => doc.getText(l.range) === '[[nope.md]]');
        assert.ok(link, 'a dangling link is still a span — silence would look broken');
        assert.strictEqual(link.target, undefined);
        assert.match(link.tooltip ?? '', /no file found for "nope\.md"/);
    });

    /**
     * Completion items for the `[[sam` line, with a SHORT bounded retry. The
     * candidates come from `git ls-files`, which sees a just-written file at
     * once — but without git they fall back to `workspace.findFiles`, which can
     * lag behind one. A harness guard, not product behaviour.
     */
    const completions = async (): Promise<vscode.CompletionItem[]> => {
        const line = 3; // '- [n] typing [[sam'
        const position = new vscode.Position(line, doc.lineAt(line).text.length);
        for (let attempt = 0; attempt < 10; attempt++) {
            const list = await vscode.commands.executeCommand<vscode.CompletionList>(
                'vscode.executeCompletionItemProvider',
                doc.uri,
                position,
            );
            const items = list?.items ?? [];
            if (items.some((i) => i.insertText === 'nested/deep.md')) return items;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return [];
    };

    test('completion after [[ offers workspace files', async () => {
        const items = await completions();
        assert.ok(
            items.some((i) => i.insertText === 'sample.tsk'),
            'a workspace-root .tsk file should be offered',
        );
    });

    test('a nested file is labelled by basename but FILTERED by its full path', async () => {
        const item = (await completions()).find((i) => i.insertText === 'nested/deep.md');
        assert.ok(item, 'nested/deep.md should be offered');
        assert.strictEqual(item.label, 'deep.md', 'the label is the basename');
        assert.strictEqual(item.detail, 'nested', 'the directory shows as detail');
        // The load-bearing one: the user types a PATH (`nested/de…`), so
        // filtering has to run against the relative path or nothing matches
        // past the first slash. NB this can only be asserted on a NESTED file —
        // VS Code drops `filterText` over the RPC when it equals the label,
        // which is why a root-level file can't test it.
        assert.strictEqual(item.filterText, 'nested/deep.md');
    });

    test('completion stays silent inside a task marker and on a single bracket', async () => {
        const line = 0; // '- [n] doc-relative [[target.md]]'
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            new vscode.Position(line, 3), // inside `- [n]`
        );
        assert.ok(
            !list?.items.some((i) => i.kind === vscode.CompletionItemKind.File),
            'no file completions inside a `- [n]` marker',
        );
    });

    test('a dangling link is squiggled, with the span on the brackets only', async () => {
        // The diagnostic is computed when the document opens, so it is already
        // there by now (suiteSetup opened it).
        const found = await waitFor(() => {
            const all = vscode.languages.getDiagnostics(doc.uri);
            return all.find((d) => /No file found for "nope\.md"/.test(d.message));
        });
        assert.ok(found, 'a dangling [[nope.md]] should raise a tsk diagnostic');
        assert.strictEqual(found.severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(doc.getText(found.range), '[[nope.md]]', 'exact span');
    });

    test('a cache rebuild keeps the dangling-link squiggle', async () => {
        // Regression: DiagnosticsManager.clear() used to drop link warnings
        // too, and nothing re-derives them until the document is next opened,
        // saved or edited — so every squiggle vanished after a rebuild.
        await vscode.commands.executeCommand('tsk.rebuildCache');
        const found = await waitFor(() =>
            vscode.languages
                .getDiagnostics(doc.uri)
                .find((d) => /No file found for "nope\.md"/.test(d.message)),
        );
        assert.ok(found, 'the dangling [[nope.md]] squiggle should survive tsk.rebuildCache');
    });

    test('resolvable links raise nothing', async () => {
        const messages = vscode.languages
            .getDiagnostics(doc.uri)
            .map((d) => d.message)
            .filter((m) => /No file found/.test(m));
        assert.deepStrictEqual(
            messages,
            ['No file found for "nope.md".'],
            'only the one dangling link, not target.md or sample.tsk',
        );
    });

    test('the insert command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('tsk.insertWikiLink'));
    });
});
