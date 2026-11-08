import * as assert from 'node:assert';
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
const CONNECTOR = [
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

    test("draws each link's status from the workspace's connector, and the hover says why one has none", async function () {
        this.timeout(60000);
        const connectors = config().inspect('linkStatus.connectors')?.workspaceValue;
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
                        command: ['sh', '-c', CONNECTOR],
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
                    [0, 'https://tickets.example/1', '● In review ✗'],
                    [1, '[the fix](https://tickets.example/2)', '● Done'],
                ],
            );

            const first = await hover(doc.uri, 0, 20);
            assert.match(first, /Ticket 1/);
            assert.match(first, /In review · checks failing/);
            // TCK-3 was in the same batch as the two drawn.
            assert.match(await hover(doc.uri, 2, 5), /No status: no ticket/);
        } finally {
            await config().update(
                'linkStatus.connectors',
                connectors,
                vscode.ConfigurationTarget.Workspace,
            );
            await config().update('autolinks', autolinks, vscode.ConfigurationTarget.Workspace);
        }
    });
});
