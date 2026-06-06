import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';
const AUTOLINKS_KEY = 'autolinks';

/**
 * Autolinks e2e. Drives the real `DocumentLinkProvider` via
 * `vscode.executeLinkProvider`. Test content lives in an *untitled* `.tsk` doc
 * rather than a fixture file — the provider has no cache dependency, and a new
 * fixture file would force a `cache.test.ts` task-count bump.
 */
suite('autolinks', () => {
    let api: TskExtensionApi;
    let settingsPath: string;
    /** Raw `.vscode/settings.json` bytes at suite start; `null` = file absent. */
    let originalSettings: string | null;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();

        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'expected a workspace folder');
        settingsPath = vscode.Uri.joinPath(folder.uri, '.vscode', 'settings.json').fsPath;
        originalSettings = fs.existsSync(settingsPath)
            ? fs.readFileSync(settingsPath, 'utf8')
            : null;
    });

    // Restore the fixture's settings.json verbatim — belt-and-suspenders against
    // a config-mutating test being killed before its `finally` runs.
    suiteTeardown(() => {
        if (originalSettings === null) {
            if (fs.existsSync(settingsPath)) fs.rmSync(settingsPath);
        } else {
            fs.writeFileSync(settingsPath, originalSettings);
        }
    });

    const config = () => vscode.workspace.getConfiguration('tsk');

    async function openTsk(content: string): Promise<vscode.TextDocument> {
        const doc = await vscode.workspace.openTextDocument({ language: 'tsk', content });
        await vscode.window.showTextDocument(doc);
        return doc;
    }

    async function linksFor(uri: vscode.Uri): Promise<vscode.DocumentLink[]> {
        const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
            'vscode.executeLinkProvider',
            uri,
        );
        return links ?? [];
    }

    test('links matching text — tagged and bare alike — and substitutes groups', async function () {
        // Headless config-update propagation is slow; give it head-room.
        this.timeout(60000);
        const original = config().inspect(AUTOLINKS_KEY)?.workspaceValue;
        try {
            await config().update(
                AUTOLINKS_KEY,
                [{ pattern: '([A-Z]+)-([0-9]+)', target: 'https://jira.example.com/$1-$2' }],
                vscode.ConfigurationTarget.Workspace,
            );
            api.refreshAutolinks();

            const doc = await openTsk(
                [
                    '- [ ] fix login #JIRAID-123',
                    '- [ ] see JIRAID-456 for details',
                    '- [ ] nothing to link here',
                ].join('\n'),
            );
            const links = await linksFor(doc.uri);
            const targets = links.map((l) => l.target?.toString());

            assert.ok(
                targets.includes('https://jira.example.com/JIRAID-123'),
                'the tagged #JIRAID-123 should link',
            );
            assert.ok(
                targets.includes('https://jira.example.com/JIRAID-456'),
                'the bare JIRAID-456 should link too (any-text scope)',
            );
            assert.strictEqual(links.length, 2, 'exactly the two JIRA refs link');

            // The link range covers only the matched text, not the whole line / `#`.
            const tagged = links.find((l) => l.target?.toString().endsWith('JIRAID-123'));
            assert.ok(tagged);
            assert.strictEqual(doc.getText(tagged.range), 'JIRAID-123');
        } finally {
            await config().update(AUTOLINKS_KEY, original, vscode.ConfigurationTarget.Workspace);
            api.refreshAutolinks();
        }
    });

    test('no links when no rule is configured', async function () {
        this.timeout(60000);
        const original = config().inspect(AUTOLINKS_KEY)?.workspaceValue;
        try {
            await config().update(AUTOLINKS_KEY, [], vscode.ConfigurationTarget.Workspace);
            api.refreshAutolinks();
            const doc = await openTsk('- [ ] JIRAID-1 should not link with no rules');
            assert.strictEqual((await linksFor(doc.uri)).length, 0);
        } finally {
            await config().update(AUTOLINKS_KEY, original, vscode.ConfigurationTarget.Workspace);
            api.refreshAutolinks();
        }
    });

    test('contributes.configuration declares tsk.autolinks as an array', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const props = ext.packageJSON.contributes.configuration.properties as Record<
            string,
            { type: string }
        >;
        assert.ok(props['tsk.autolinks'], 'tsk.autolinks should be a contributed setting');
        assert.strictEqual(props['tsk.autolinks'].type, 'array');
    });
});
