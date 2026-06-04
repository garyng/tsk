import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';

/**
 * `tsk.markNow` (Alt+W) e2e (M45). Drives the command against untitled `.tsk`
 * docs (so it doesn't perturb the workspace-fixture cache counts) and asserts
 * the now-tree + the persistent decoration via the test API getters — the only
 * way to read decoration state, which VSCode doesn't expose directly.
 *
 * The now-store is a single in-memory instance (the fixture sets
 * `tsk.state.path: ""`), so marks accumulate across tests; assertions are
 * therefore current-focused (`getNowTaskId` / the tree's `currentEntryId`),
 * which the accumulation doesn't disturb. M48 adds the tree-action commands
 * (branch / back / remove / prune / jump) + rebuild-survival here; the
 * exhaustive reducer logic stays in the now-tree + now-store unit suites.
 */
suite('now feature (M45 mark + M48 tree actions)', () => {
    let api: TskExtensionApi;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();
    });

    setup(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await new Promise((resolve) => setImmediate(resolve));
    });

    /** Open an untitled `.tsk` doc with `content`, put the cursor on `line`, run Alt+W. */
    async function markNow(content: string, line = 0): Promise<vscode.TextDocument> {
        const doc = await vscode.workspace.openTextDocument({ content, language: 'tsk' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selections = [new vscode.Selection(line, 0, line, 0)];
        await new Promise((resolve) => setImmediate(resolve));
        await vscode.commands.executeCommand('tsk.markNow');
        await new Promise((resolve) => setImmediate(resolve));
        return doc;
    }

    /**
     * Mark a fresh task carrying an explicit `@id`, returning its tree `entryId`
     * (the just-marked task is always the new current). The store accumulates
     * across tests, so each test references its OWN entryIds — never the whole
     * tree — which the accumulation can't disturb.
     */
    async function mark(content: string, id: string): Promise<string> {
        await markNow(`${content} <!-- @id:${id} -->`);
        const current = api.getNowTree().currentEntryId;
        assert.ok(current, `marking ${id} should set a current entry`);
        return current;
    }

    const run = (command: string, ...args: unknown[]): Thenable<unknown> =>
        vscode.commands.executeCommand(command, ...args);

    test('stamps @id, sets [/], becomes the current now, and decorates the line', async () => {
        const doc = await markNow('- [ ] write the spec');

        const line = doc.lineAt(0).text;
        assert.match(
            line,
            /^- \[\/\] write the spec <!-- @id:[a-z0-9]+ @created:[\d\-T:+]+ -->$/,
            'should stamp @id + @created and set the [/] marker',
        );
        const id = /@id:([a-z0-9]+)/.exec(line)?.[1];
        assert.ok(id);

        assert.strictEqual(api.getNowTaskId(), id, 'the stamped id is the current now');
        const tree = api.getNowTree();
        const current = tree.entries.find((e) => e.entryId === tree.currentEntryId);
        assert.strictEqual(current?.id, id, 'the current tree node points at the marked task');

        const deco = api.getNowDecoration();
        assert.ok(deco, 'a now-decoration should be painted on the visible task');
        assert.strictEqual(deco.uri, doc.uri.toString());
        assert.strictEqual(deco.line, 0);
    });

    test('marking a second task moves the current now (child of the first) and the decoration', async () => {
        await markNow('- [ ] first task <!-- @id:m45-first -->');
        assert.strictEqual(api.getNowTaskId(), 'm45-first');

        const doc = await markNow('- [ ] second task <!-- @id:m45-second -->');
        assert.strictEqual(api.getNowTaskId(), 'm45-second', 'current advances to the new mark');

        const tree = api.getNowTree();
        const current = tree.entries.find((e) => e.entryId === tree.currentEntryId);
        assert.strictEqual(current?.id, 'm45-second');
        const parent = tree.entries.find((e) => e.entryId === current?.parentId);
        assert.strictEqual(parent?.id, 'm45-first', 'the new now is a child of the previous now');

        const deco = api.getNowDecoration();
        assert.ok(deco);
        assert.strictEqual(deco.uri, doc.uri.toString(), 'decoration follows the current now');
        assert.strictEqual(deco.line, 0);
    });

    test('marking a non-task line is a no-op (no file edit, current unchanged)', async () => {
        await markNow('- [ ] a real task <!-- @id:m45-real -->');
        assert.strictEqual(api.getNowTaskId(), 'm45-real');

        const doc = await markNow('just some prose, not a task');
        assert.strictEqual(
            doc.lineAt(0).text,
            'just some prose, not a task',
            'a non-task line must not be edited',
        );
        assert.strictEqual(api.getNowTaskId(), 'm45-real', 'the current now must be unchanged');
    });

    test('contributes Alt+W → tsk.markNow, gated to tsk editors', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const keybindings = ext.packageJSON.contributes.keybindings as ReadonlyArray<{
            command: string;
            key: string;
            when: string;
        }>;
        const kb = keybindings.find((k) => k.command === 'tsk.markNow');
        assert.ok(kb, 'expected a keybinding for tsk.markNow');
        assert.strictEqual(kb.key, 'alt+w');
        assert.strictEqual(kb.when, "editorLangId == 'tsk' && editorTextFocus");
    });

    test('tsk.now.openStack opens the Now Stack panel without throwing', async () => {
        // Smoke: createWebviewPanel + the nonce/CSP HTML build cleanly. The React
        // mount, the message bridge, and "Move into a New Window" are dev-host
        // (manual) checks — the webview DOM isn't reachable from the e2e API.
        await vscode.commands.executeCommand('tsk.now.openStack');
        await new Promise((resolve) => setImmediate(resolve));

        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const commands = ext.packageJSON.contributes.commands as ReadonlyArray<{ command: string }>;
        assert.ok(
            commands.some((c) => c.command === 'tsk.now.openStack'),
            'tsk.now.openStack should be contributed',
        );
    });

    // ── M48: the now-tree action commands (the webview drives these) ──────────

    test('branching: switchTo an ancestor then mark keeps BOTH children', async () => {
        const a = await mark('- [ ] branch A', 'm48-bA');
        const b = await mark('- [ ] branch B', 'm48-bB'); // child of A, current = B
        await run('tsk.now.switchTo', a);
        assert.strictEqual(api.getNowTree().currentEntryId, a, 'switchTo moved current to A');
        const c = await mark('- [ ] branch C', 'm48-bC'); // child of A, current = C
        const tree = api.getNowTree();
        const kids = tree.entries.filter((e) => e.parentId === a).map((e) => e.entryId);
        assert.ok(kids.includes(b) && kids.includes(c), 'A keeps both B and C (undo never prunes)');
        assert.strictEqual(tree.currentEntryId, c, 'current is the newest mark');
    });

    test('tsk.now.back switches the current to its parent', async () => {
        const a = await mark('- [ ] back A', 'm48-backA');
        await mark('- [ ] back B', 'm48-backB'); // child of A, current = B
        await run('tsk.now.back');
        assert.strictEqual(api.getNowTree().currentEntryId, a, 'back re-homed current to A');
    });

    test('tsk.now.remove drops a node and re-parents its child onto the grandparent', async () => {
        const p = await mark('- [ ] rm parent', 'm48-rmP');
        const mid = await mark('- [ ] rm mid', 'm48-rmMid'); // child of P
        const leaf = await mark('- [ ] rm leaf', 'm48-rmLeaf'); // child of mid
        await run('tsk.now.remove', mid);
        const tree = api.getNowTree();
        assert.ok(!tree.entries.some((e) => e.entryId === mid), 'mid is removed');
        assert.strictEqual(
            tree.entries.find((e) => e.entryId === leaf)?.parentId,
            p,
            'leaf re-parented onto P',
        );
    });

    test('tsk.now.pruneSubtree drops the node and all of its descendants', async () => {
        const root = await mark('- [ ] prune root', 'm48-pRoot');
        const child = await mark('- [ ] prune child', 'm48-pChild'); // child of root
        const grand = await mark('- [ ] prune grand', 'm48-pGrand'); // child of child
        await run('tsk.now.pruneSubtree', child);
        const tree = api.getNowTree();
        assert.ok(
            !tree.entries.some((e) => e.entryId === child || e.entryId === grand),
            'child + grandchild are gone',
        );
        assert.ok(
            tree.entries.some((e) => e.entryId === root),
            'root survives',
        );
    });

    test('tsk.now.pruneChildren drops descendants but keeps the node + re-homes current', async () => {
        const a = await mark('- [ ] pc A', 'm48-pcA');
        const b = await mark('- [ ] pc B', 'm48-pcB'); // child of A
        const c = await mark('- [ ] pc C', 'm48-pcC'); // child of B, current = C
        await run('tsk.now.pruneChildren', a);
        const tree = api.getNowTree();
        assert.ok(
            tree.entries.some((e) => e.entryId === a),
            'A itself is kept',
        );
        assert.ok(
            !tree.entries.some((e) => e.entryId === b || e.entryId === c),
            'A descendants are gone',
        );
        assert.strictEqual(tree.currentEntryId, a, 'current re-homed onto A');
    });

    test('tsk.now.jump reveals the marked task and paints the navigation highlight', async () => {
        const doc = await markNow('- [ ] jump here <!-- @id:m48-jump -->');
        const editor = vscode.window.activeTextEditor;
        assert.ok(editor);
        editor.selection = new vscode.Selection(0, 3, 0, 3); // move cursor off the start
        await run('tsk.now.jump', 'm48-jump');
        await new Promise((resolve) => setImmediate(resolve));
        const hl = api.getNavigationHighlight();
        assert.ok(hl, 'jump paints a navigation highlight on the task line');
        assert.strictEqual(hl.line, 0);
        assert.strictEqual(hl.uri, doc.uri.toString());
    });

    test('the now-tree survives tsk.rebuildCache (state.db is separate from cache.db)', async () => {
        await mark('- [ ] survive the rebuild', 'm48-survive');
        const before = api.getNowTree();
        await run('tsk.rebuildCache');
        await new Promise((resolve) => setImmediate(resolve));
        const after = api.getNowTree();
        assert.strictEqual(after.currentEntryId, before.currentEntryId, 'current survives');
        assert.deepStrictEqual(
            after.entries.map((e) => e.entryId).sort(),
            before.entries.map((e) => e.entryId).sort(),
            'every entry survives the cache rebuild',
        );
    });
});
