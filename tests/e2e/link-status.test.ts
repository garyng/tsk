import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

/**
 * Link status e2e: a connector
 * in the workspace's settings, as a repo can name its own, answering for an
 * untitled `.tsk` doc's links: a bare URL, a Markdown link, and an autolink.
 * The drawn text comes from the extension API, since VS Code doesn't hand
 * back what decorations show; the hover from `vscode.executeHoverProvider`.
 */

// Ticket 1 is in review with failing checks, 2 is done, any other has no ticket.
// Each run adds a line to the log named by its first argument.
const CONNECTOR = [
    'echo run >> "$1"',
    'while IFS= read -r url; do',
    '  case "${url##*/}" in',
    `    1) printf '{"url":"%s","label":"In review","category":"inProgress","checks":"failing","title":"Ticket 1"}\\n' "$url" ;;`,
    `    2) printf '{"url":"%s","label":"Done","category":"done"}\\n' "$url" ;;`,
    `    *) printf '{"url":"%s","error":"no ticket"}\\n' "$url" ;;`,
    '  esac',
    'done',
].join('\n');

suite('link status', () => {
    let api: TskExtensionApi;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>('garyng.tsk');
        assert.ok(ext, 'extension garyng.tsk should be discoverable');
        api = await ext.activate();
    });

    const config = () => vscode.workspace.getConfiguration('tsk');

    async function until<T>(get: () => T | undefined, what: string, ms = 20_000): Promise<T> {
        const end = Date.now() + ms;
        for (;;) {
            const value = get();
            if (value !== undefined) return value;
            if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
            await new Promise((r) => setTimeout(r, 100));
        }
    }

    async function hover(uri: vscode.Uri, line: number, character: number): Promise<string> {
        const hovers =
            (await vscode.commands.executeCommand<vscode.Hover[]>(
                'vscode.executeHoverProvider',
                uri,
                new vscode.Position(line, character),
            )) ?? [];
        return hovers
            .flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value)))
            .join('\n---\n')
            .replaceAll('&nbsp;', ' '); // appendText keeps the service's spaces as &nbsp;
    }

    async function inlayHints(uri: vscode.Uri, range: vscode.Range): Promise<vscode.InlayHint[]> {
        return (
            (await vscode.commands.executeCommand<vscode.InlayHint[]>(
                'vscode.executeInlayHintProvider',
                uri,
                range,
            )) ?? []
        );
    }
    const labelOf = (h: vscode.InlayHint) =>
        typeof h.label === 'string' ? h.label : h.label.map((p) => p.value).join('');

    test("draws each link's status from the workspace's connector, and the hover says why one has none", async function () {
        this.timeout(60000);
        const connectors = config().inspect('linkStatus.connectors')?.workspaceValue;
        const runs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tsk-connector-')), 'runs');
        fs.writeFileSync(runs, '');
        const autolinks = config().inspect('autolinks')?.workspaceValue;
        try {
            await config().update(
                'autolinks',
                [{ pattern: 'TCK-([0-9]+)', target: 'https://tickets.example/$1' }],
                vscode.ConfigurationTarget.Workspace,
            );
            await config().update(
                'linkStatus.connectors',
                [
                    {
                        name: 'tickets',
                        match: '^https://tickets\\.example/',
                        command: ['sh', '-c', CONNECTOR, 'sh', runs],
                    },
                ],
                vscode.ConfigurationTarget.Workspace,
            );
            const doc = await vscode.workspace.openTextDocument({
                language: 'tsk',
                content: [
                    '- [ ] review https://tickets.example/1',
                    '  - [the fix](https://tickets.example/2)',
                    '  - TCK-3, and https://elsewhere.example/4 which no connector takes',
                ].join('\n'),
            });
            await vscode.window.showTextDocument(doc);

            const marks = await until(() => {
                const m = api.getLinkStatus(doc.uri.toString());
                return m?.length === 2 ? m : undefined;
            }, 'the two statuses');
            assert.deepStrictEqual(
                marks.map((m) => [
                    m.line,
                    doc.getText(new vscode.Range(m.line, m.startCol, m.line, m.endCol)),
                    m.text,
                ]),
                [
                    [0, 'https://tickets.example/1', 'In review ✗'],
                    [1, '[the fix](https://tickets.example/2)', 'Done'],
                ],
            );

            const first = await hover(doc.uri, 0, 20);
            assert.match(first, /Ticket 1/);
            assert.match(first, /In review · checks failing/);
            // TCK-3 was in the same batch as the two drawn.
            assert.match(await hover(doc.uri, 2, 5), /No status: no ticket/);

            // Clearing the cache fetches what's on screen again.
            const ran = () => fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length;
            const before = ran();
            await vscode.commands.executeCommand('tsk.clearLinkStatusCache');
            await until(() => (ran() > before ? true : undefined), 'a run after the clear');
            await until(
                () => (api.getLinkStatus(doc.uri.toString())?.length === 2 ? true : undefined),
                'the statuses back',
            );

            // Each chip floats over a blank inlay hint as wide as it, a space before it; the hint
            // takes the room when the line wraps, and Ctrl+Click on it opens the link.
            const all = new vscode.Range(0, 0, doc.lineCount, 0);
            const hints = await inlayHints(doc.uri, all);
            assert.deepStrictEqual(
                hints.map((h) => [h.position.line, h.position.character, labelOf(h)]),
                [
                    [0, 38, '\u00a0'.repeat(' In review ✗ '.length + 1)],
                    [1, 40, '\u00a0'.repeat(' Done '.length + 1)],
                ],
            );
            const [part] = hints[0]?.label as vscode.InlayHintLabelPart[];
            assert.deepStrictEqual(part?.command?.arguments, ['https://tickets.example/1']);

            // Hints not always shown can't hold the room: the chip goes in the line, no hint.
            await vscode.workspace
                .getConfiguration('editor')
                .update(
                    'inlayHints.enabled',
                    'offUnlessPressed',
                    vscode.ConfigurationTarget.Workspace,
                );
            assert.deepStrictEqual(await inlayHints(doc.uri, all), []);
            assert.strictEqual(api.getLinkStatus(doc.uri.toString())?.length, 2);

            // With the connector gone, its links go bare, cached statuses and all.
            await config().update(
                'linkStatus.connectors',
                undefined,
                vscode.ConfigurationTarget.Workspace,
            );
            await until(
                () => (api.getLinkStatus(doc.uri.toString())?.length === 0 ? true : undefined),
                'the statuses to go',
            );
            // The line's task hover stays; the link's status doesn't.
            assert.doesNotMatch(await hover(doc.uri, 0, 20), /In review|fetched/);
        } finally {
            fs.rmSync(path.dirname(runs), { recursive: true, force: true });
            await vscode.workspace
                .getConfiguration('editor')
                .update('inlayHints.enabled', undefined, vscode.ConfigurationTarget.Workspace);
            await config().update(
                'linkStatus.connectors',
                connectors,
                vscode.ConfigurationTarget.Workspace,
            );
            await config().update('autolinks', autolinks, vscode.ConfigurationTarget.Workspace);
        }
    });
    test('offers to sign in to GitHub on a GitHub link, with GitHub on and no session', async function () {
        this.timeout(60000);
        const enabled = config().inspect('linkStatus.github.enabled')?.workspaceValue;
        try {
            await config().update(
                'linkStatus.github.enabled',
                true,
                vscode.ConfigurationTarget.Workspace,
            );
            const doc = await vscode.workspace.openTextDocument({
                language: 'tsk',
                content: '- [ ] review https://github.com/octo-org/octo-repo/pull/1',
            });
            await vscode.window.showTextDocument(doc);
            // No session in the test host: the connector answers without asking GitHub.
            let text = '';
            const end = Date.now() + 20_000;
            while (!/not signed in to GitHub/.test(text) && Date.now() < end) {
                await new Promise((r) => setTimeout(r, 200));
                text = await hover(doc.uri, 0, 20);
            }
            assert.match(text, /No status: not signed in to GitHub/);
            assert.match(text, /\[Sign in to GitHub\]\(command:tsk\.signInToGitHub\)/);
        } finally {
            await config().update(
                'linkStatus.github.enabled',
                enabled,
                vscode.ConfigurationTarget.Workspace,
            );
        }
    });
    test('offers to set a Jira API token on a Jira link with none kept for its site, the site filled in', async function () {
        this.timeout(60000);
        const doc = await vscode.workspace.openTextDocument({
            language: 'tsk',
            content: '- [ ] fix https://acme.atlassian.net/browse/ABC-12',
        });
        await vscode.window.showTextDocument(doc);
        // No token kept for acme: the connector answers without asking Jira.
        let text = '';
        const end = Date.now() + 20_000;
        while (!/no Jira API token/.test(text) && Date.now() < end) {
            await new Promise((r) => setTimeout(r, 200));
            text = await hover(doc.uri, 0, 20);
        }
        assert.match(text, /No status: no Jira API token for acme\.atlassian\.net/);
        const site = encodeURIComponent(JSON.stringify(['https://acme.atlassian.net']));
        assert.ok(
            text.includes(`[Set Jira API Token](command:tsk.setJiraApiToken?${site})`),
            `the hover links to setting acme's token: ${text}`,
        );
    });
});
