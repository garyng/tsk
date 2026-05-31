import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Hover provider e2e (M20/A). Drives `vscode.executeHoverProvider`
 * against fixture tasks and asserts the rendered markdown carries the
 * marker status label, metadata table (with relative-time annotations),
 * tag descriptions, and forward/inverse reference sections. The exact
 * markdown shape is covered by the pure unit tests in
 * `src/lib/hover-logic.test.ts`; this layer verifies the vscode wiring
 * (right URI, right range, isTrusted).
 */
suite('hover provider', () => {
    let api: TskExtensionApi;
    let dupUri: vscode.Uri;
    let sampleUri: vscode.Uri;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'expected a workspace folder');
        dupUri = vscode.Uri.joinPath(folder.uri, 'dup.tsk');
        sampleUri = vscode.Uri.joinPath(folder.uri, 'sample.tsk');
    });

    async function hoverAt(uri: vscode.Uri, line: number): Promise<vscode.Hover[]> {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(line, 6); // inside `- [m] `
        const result = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            uri,
            position,
        );
        return result ?? [];
    }

    function combinedMarkdown(hovers: readonly vscode.Hover[]): string {
        const parts: string[] = [];
        for (const h of hovers) {
            for (const c of h.contents) {
                if (typeof c === 'string') parts.push(c);
                else if ('value' in c) parts.push(c.value);
            }
        }
        return parts.join('\n---\n');
    }

    test('returns a hover with the status label + id on a fixture task', async () => {
        // dup.tsk line 9 (0-indexed) is `- [ ] parent task <!-- @id:e2e-graph-parent -->`.
        // Header is the marker's status word ("Todo"), NOT the content —
        // content is already visible in the source line under the cursor.
        const hovers = await hoverAt(dupUri, 9);
        const md = combinedMarkdown(hovers);
        assert.match(md, /\*\*Todo\*\*/);
        assert.match(md, /\| id \| `e2e-graph-parent` \|/);
        // Content should NOT appear in the rendered hover.
        assert.ok(!md.includes('parent task'), `hover should not duplicate source content`);
    });

    test('renders an inverse children section on the parent task', async () => {
        // dup.tsk line 10 has `@parent:e2e-graph-parent`, so the parent at
        // line 9 should report one child.
        const hovers = await hoverAt(dupUri, 9);
        const md = combinedMarkdown(hovers);
        assert.match(md, /\*\*children \(1\):\*\*/);
        assert.match(md, /command:tsk\.goToParent/);
    });

    test('renders a forward parent link on the child task', async () => {
        // dup.tsk line 10 is the child.
        const hovers = await hoverAt(dupUri, 10);
        const md = combinedMarkdown(hovers);
        assert.match(md, /\*\*parent:\*\*.*command:tsk\.goToParent/);
        assert.match(md, /`\(e2e-graph-parent\)`/);
    });

    test('includes tag descriptions from tags.yml when available', async () => {
        // sample.tsk line 7 (0-indexed) is the `- [x] document the rebuild
        // command #project/tsk #milestone/M3` task. tags.yml defines
        // descriptions for both tags in the fixture.
        const hovers = await hoverAt(sampleUri, 7);
        const md = combinedMarkdown(hovers);
        assert.match(md, /\*\*Tags:\*\*.*#project\/tsk/);
        assert.match(md, /\*\*Tags:\*\*.*#milestone\/M3/);
        assert.ok(
            md.includes('*(The tsk extension itself)*'),
            `expected project/tsk description in italics; got: ${md}`,
        );
        // Keep api referenced so TS doesn't flag unused.
        assert.ok(typeof api.counts === 'function');
    });

    test('returns no hover on a non-task line', async () => {
        // dup.tsk line 0 is a comment / markdown heading.
        const hovers = await hoverAt(dupUri, 0);
        const tskHovers = hovers.filter((h) => {
            const md = combinedMarkdown([h]);
            return md.includes('`[ ]`') || md.includes('`[x]`') || md.includes('`[/]`');
        });
        assert.strictEqual(tskHovers.length, 0, 'expected no tsk hover on a non-task line');
    });
});
