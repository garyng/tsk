import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Ctrl+click a `#tag` → its `tags.yml` declaration, via the native
 * `DefinitionProvider` (which is what ctrl+click already runs). Asserted
 * against the shared `fixtures/workspace/.vscode/tsk/tags.yml`; this suite
 * only ever READS it, since `tags-completion.test.ts` depends on its exact
 * contents.
 */
suite('tag definition', () => {
    let doc: vscode.TextDocument;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();

        doc = await vscode.workspace.openTextDocument({
            content: [
                '- [ ] declared #project/tsk',
                '- [ ] shorthand #milestone/M3',
                '- [ ] undeclared #never-declared-anywhere',
                '- [ ] no tags here',
            ].join('\n'),
            language: 'tsk',
        });
        await vscode.window.showTextDocument(doc);
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    /** Column just inside the tag (one past its `#`), so positions aren't hand-counted. */
    const tagColumn = (line: number): number => doc.lineAt(line).text.indexOf('#') + 1;

    const definitions = async (line: number): Promise<vscode.Location[]> =>
        (await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeDefinitionProvider',
            doc.uri,
            new vscode.Position(line, tagColumn(line)),
        )) ?? [];

    test('a declared tag resolves to its line in tags.yml', async () => {
        const [location] = await definitions(0);
        assert.ok(location, 'ctrl+click on #project/tsk should resolve');
        assert.ok(
            location.uri.fsPath.endsWith('tags.yml'),
            `expected tags.yml, got ${location.uri.fsPath}`,
        );
        const yaml = await vscode.workspace.openTextDocument(location.uri);
        assert.match(
            yaml.lineAt(location.range.start.line).text,
            /^project\/tsk:/,
            'should land on the key line itself',
        );
    });

    test('a string-shorthand declaration resolves too', async () => {
        const [location] = await definitions(1);
        assert.ok(location, 'ctrl+click on #milestone/M3 should resolve');
        const yaml = await vscode.workspace.openTextDocument(location.uri);
        assert.match(yaml.lineAt(location.range.start.line).text, /^milestone\/M3:/);
    });

    test('an undeclared tag resolves to nothing — VS Code says so for us', async () => {
        assert.deepStrictEqual(
            await definitions(2),
            [],
            'silence here is VS Code’s own "no definition found", which is truthful',
        );
    });

    test('the define quick fix is offered for an undeclared tag only', async () => {
        const onUndeclared = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider',
            doc.uri,
            new vscode.Range(2, tagColumn(2), 2, tagColumn(2)),
        );
        assert.ok(
            onUndeclared?.some((a) => a.title === 'Define #never-declared-anywhere in tags.yml…'),
            'an undeclared tag should offer the define action',
        );

        const onDeclared = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider',
            doc.uri,
            new vscode.Range(0, tagColumn(0), 0, tagColumn(0)),
        );
        assert.ok(
            !onDeclared?.some((a) => a.title.startsWith('Define #')),
            'an already-declared tag should not offer it',
        );
    });

    test('nothing is offered off a tag', async () => {
        assert.deepStrictEqual(await definitions(3), []);
    });

    test('the define command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('tsk.defineTag'));
    });
});
