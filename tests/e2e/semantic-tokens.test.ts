import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';
import { SEMANTIC_TOKENS_LEGEND } from '../../src/semantic-tokens';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Semantic-token e2e (M41). Markers are colored through VS Code's tokenization
 * pipeline rather than decorations, so we assert via the built-in
 * `vscode.provideDocumentSemanticTokens` command and decode the delta-encoded
 * `Uint32Array` against the provider's legend. Pure token computation is covered
 * in `src/lib/semantic-tokens.test.ts`; this verifies the provider + legend wire
 * through the real host.
 */
interface DecodedToken {
    line: number;
    char: number;
    length: number;
    type: string;
    modifiers: string[];
}

function decode(tokens: vscode.SemanticTokens): DecodedToken[] {
    const { tokenTypes, tokenModifiers } = SEMANTIC_TOKENS_LEGEND;
    const out: DecodedToken[] = [];
    let line = 0;
    let char = 0;
    for (let i = 0; i < tokens.data.length; i += 5) {
        const deltaLine = tokens.data[i] as number;
        const deltaChar = tokens.data[i + 1] as number;
        const length = tokens.data[i + 2] as number;
        const typeIdx = tokens.data[i + 3] as number;
        const modBits = tokens.data[i + 4] as number;
        line += deltaLine;
        char = deltaLine === 0 ? char + deltaChar : deltaChar;
        out.push({
            line,
            char,
            length,
            type: tokenTypes[typeIdx] as string,
            modifiers: tokenModifiers.filter((_, b) => (modBits & (1 << b)) !== 0),
        });
    }
    return out;
}

async function provide(uri: vscode.Uri): Promise<DecodedToken[]> {
    const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
        'vscode.provideDocumentSemanticTokens',
        uri,
    );
    assert.ok(tokens, 'semantic tokens provider returned a result');
    return decode(tokens);
}

suite('semantic tokens (marker coloring)', () => {
    let sampleUri: vscode.Uri;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
        const firstFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(firstFolder, 'expected a workspace folder');
        sampleUri = vscode.Uri.joinPath(firstFolder.uri, 'sample.tsk');
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sampleUri));
        await new Promise((resolve) => setImmediate(resolve));
    });

    test('every fixture marker triplet gets a taskMarker token with its status modifier', async () => {
        const markers = (await provide(sampleUri)).filter((t) => t.type === 'taskMarker');
        const byLine = new Map(markers.map((t) => [t.line, t]));
        // sample.tsk markers (0-indexed): 5 todo, 6 inprogress, 7 completed, 8 todo.
        for (const [line, status] of [
            [5, 'todo'],
            [6, 'inprogress'],
            [7, 'completed'],
            [8, 'todo'],
        ] as const) {
            const tok = byLine.get(line);
            assert.ok(tok, `expected a marker token on line ${line}`);
            assert.strictEqual(tok.type, 'taskMarker');
            assert.deepStrictEqual(
                tok.modifiers,
                [status],
                `line ${line} should classify as ${status}`,
            );
            assert.strictEqual(tok.length, 3, 'token covers the [X] triplet');
            assert.strictEqual(tok.char, 2, 'token starts at the [ bracket');
        }
    });

    test('inline <!-- ... --> metadata gets a taskMetadata token (no modifier)', async () => {
        const meta = (await provide(sampleUri)).filter((t) => t.type === 'taskMetadata');
        // All four fixture tasks (0-indexed lines 5-8) carry metadata.
        assert.deepStrictEqual(
            meta.map((t) => t.line).sort((a, b) => a - b),
            [5, 6, 7, 8],
        );
        assert.ok(
            meta.every((t) => t.modifiers.length === 0),
            'metadata tokens carry no status modifier',
        );
    });

    test('toggling a status reclassifies the marker token (the instant-recolor path)', async () => {
        // Untitled so the fixture isn't mutated.
        const doc = await vscode.workspace.openTextDocument({
            content: '- [ ] flip me',
            language: 'tsk',
        });
        const editor = await vscode.window.showTextDocument(doc);
        await new Promise((resolve) => setImmediate(resolve));

        // The marker is the first (lowest-char) token; before any edit it's todo.
        assert.deepStrictEqual((await provide(doc.uri))[0]?.modifiers, ['todo']);

        editor.selection = new vscode.Selection(0, 0, 0, 0);
        await vscode.commands.executeCommand('tsk.toggleInprogress');
        await new Promise((resolve) => setImmediate(resolve));

        assert.deepStrictEqual(
            (await provide(doc.uri))[0]?.modifiers,
            ['inprogress'],
            'the same triplet now classifies as inprogress',
        );

        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });

    test('contributes the taskMarker token type + the six status modifiers', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const contributes = ext.packageJSON.contributes as {
            semanticTokenTypes: { id: string }[];
            semanticTokenModifiers: { id: string }[];
        };
        assert.ok(contributes.semanticTokenTypes.some((t) => t.id === 'taskMarker'));
        const mods = contributes.semanticTokenModifiers.map((m) => m.id);
        for (const status of ['todo', 'inprogress', 'completed', 'moved', 'cancelled', 'notes']) {
            assert.ok(mods.includes(status), `modifier ${status} should be contributed`);
        }
    });
});
