import * as assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';

/**
 * `tsk:<id>` in the Markdown preview. A preview's page can't be read from a
 * test, so the HTML comes from `markdown.api.render`, the Markdown extension's
 * own renderer with the contributed plugins in it; following a link goes
 * through the URI handler, as a click in the preview does.
 */
suite('tsk:<id> in the Markdown preview', () => {
    let api: TskExtensionApi;
    let sampleUri: vscode.Uri;
    let dir: string;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();
        const firstFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(firstFolder, 'expected a workspace folder');
        sampleUri = vscode.Uri.joinPath(firstFolder.uri, 'sample.tsk');
        dir = mkdtempSync(join(tmpdir(), 'tsk-preview-e2e-'));
    });

    setup(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        rmSync(dir, { recursive: true, force: true });
    });

    const render = (markdown: string) =>
        vscode.commands.executeCommand<string>('markdown.api.render', markdown);
    /** Each link with the marker after it; the preview may add attributes of its own. */
    const links = (html: string) =>
        [...html.matchAll(/<a ([^>]*)>([^<]*)<\/a>(<span[^>]*>[^<]*<\/span>)?/g)].map((m) => {
            const attr = (name: string) =>
                new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(m[1] ?? '')?.[1];
            return { href: attr('href'), title: attr('title'), text: m[2], marker: m[3] };
        });

    test('known ids and unknown generated-looking ids are links, each with its marker; tsk:test is not', async () => {
        const html = await render(
            'tsk:m3task3 is done; tsk:zzzzzzzz is no task; run task tsk:test',
        );
        const found = links(html);
        assert.deepStrictEqual(
            found.map((l) => l.text),
            ['tsk:m3task3', 'tsk:zzzzzzzz'],
        );
        const [known, unknown] = found;
        assert.strictEqual(known?.title, api.findTaskById('m3task3')?.content);
        assert.match(known?.marker ?? '', /data-marker="completed".*>\[x\]<\/span>$/);
        assert.match(
            known?.href ?? '',
            new RegExp(`^${vscode.env.uriScheme}://garyng\\.tsk/open\\?`),
        );
        assert.strictEqual(unknown?.title, 'No task tsk:zzzzzzzz in the workspace');
        assert.match(unknown?.marker ?? '', />\[\?\]<\/span>$/);
        assert.doesNotMatch(html, /tsk:test<\/a>/);
    });

    test('following a link reveals the task', async () => {
        const [link] = links(await render('- tsk:m3task2'));
        assert.ok(link?.href, 'tsk:m3task2 should be a link');
        await api.openTaskUri(link.href.replaceAll('&amp;', '&'));
        const active = vscode.window.activeTextEditor;
        assert.strictEqual(active?.document.uri.toString(), sampleUri.toString());
        assert.strictEqual(active?.selection.active.line, api.findTaskById('m3task2')?.line);
    });

    test('a rescan renders an open preview again, and only then', async () => {
        assert.strictEqual(api.refreshMarkdownPreviews(), false, 'no preview is open');
        const plan = join(dir, 'plan.md');
        writeFileSync(plan, '# A plan\n\n- tsk:m3task3\n');
        await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(plan));
        let refreshed = false;
        for (let attempt = 0; attempt < 40 && !refreshed; attempt++) {
            refreshed = api.refreshMarkdownPreviews();
            if (!refreshed) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(refreshed, 'the preview should be found within two seconds');
    });
});
