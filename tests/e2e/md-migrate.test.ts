import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';
const T1 = '2026-01-05T09:00:00+08:00';
const T2 = '2026-02-06T10:30:00+08:00';

/** Escape a literal (the ISO stamps carry regex-significant `+`) for RegExp embedding. */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `tsk.migrateMarkdownTasks` e2e: a REAL scripted git repo (built in
 * suiteSetup with fixed author dates) backs the stamp assertions — the md
 * marker vocabulary ([/]=done, [x]=cancelled, [>>]=moved) is remapped to tsk
 * glyphs and @created/@completed/@cancelled/@moved come from the commits
 * that did the thing. Uncommitted lines fall back to `now`.
 */
suite('migrate markdown tasks', () => {
    let repo: string;

    const git = (args: string[], env?: Record<string, string>): void => {
        execFileSync('git', args, { cwd: repo, env: { ...process.env, ...env } });
    };
    const commit = (message: string, iso: string): void =>
        git(['commit', '-qm', message], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
    const writeRepoFile = (name: string, content: string): void =>
        writeFileSync(join(repo, name), content);

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();

        repo = mkdtempSync(join(tmpdir(), 'tsk-md-e2e-'));
        git(['init', '-q']);
        git(['config', 'user.name', 'e2e']);
        git(['config', 'user.email', 'e2e@test.local']);

        // tasks.md: every default-map glyph + non-task lines; beta flips at T2.
        const v1 = [
            '# the list',
            '- [ ] alpha',
            '- [ ] beta',
            '- [x] gamma',
            '- [>>] delta',
            '- [n] memo',
            '- [x](https://example.com) a link, not a task',
            '- bare bullet',
            '',
        ].join('\n');
        writeRepoFile('tasks.md', v1);
        git(['add', 'tasks.md']);
        commit('add tasks', T1);
        writeRepoFile('tasks.md', v1.replace('- [ ] beta', '- [/] beta'));
        git(['add', 'tasks.md']);
        commit('beta done', T2);
        // An UNCOMMITTED task line appended on disk — the now-fallback case.
        writeRepoFile('tasks.md', `${v1.replace('- [ ] beta', '- [/] beta')}- [/] fresh\n`);

        // single.md / selection.md for the scoped flows (single commit each).
        writeRepoFile('single.md', '- [ ] only this one\n- [ ] not this one\n');
        git(['add', 'single.md']);
        commit('add single', T1);
        writeRepoFile('selection.md', '- [ ] one\n- [ ] two\n- [ ] three\n');
        git(['add', 'selection.md']);
        commit('add selection', T1);

        // move.md: an id-carrying (migrated) top task whose children are RAW
        // md tasks — the move must convert them on the way out (M4).
        writeRepoFile(
            'move.md',
            [
                `- [x] parent done <!-- @id:mvtop1 @created:${T1} @completed:${T1} -->`,
                '    - [/] child done',
                '    - [>>] child moved',
                '    - loose note',
                '- [ ] stays behind',
                '',
            ].join('\n'),
        );
        git(['add', 'move.md']);
        commit('add move fixture', T1);
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        rmSync(repo, { recursive: true, force: true });
    });

    const open = async (name: string): Promise<vscode.TextDocument> => {
        const doc = await vscode.workspace.openTextDocument(join(repo, name));
        await vscode.window.showTextDocument(doc);
        return doc;
    };

    /**
     * Query code actions with a SHORT bounded retry: under full-suite load the
     * provider query was observed (once) to come back empty before the
     * extension's providers answered — a harness timing flake, not product
     * behavior, so the retry lives here in the test, commented and bounded.
     */
    const queryActions = async (
        uri: vscode.Uri,
        range: vscode.Range,
        title: string,
    ): Promise<boolean> => {
        for (let attempt = 0; attempt < 5; attempt++) {
            const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
                'vscode.executeCodeActionProvider',
                uri,
                range,
            );
            if (actions?.some((a) => a.title === title)) return true;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return false;
    };

    test('bulk migrate: remaps every glyph with git-derived stamps; non-tasks untouched', async () => {
        const doc = await open('tasks.md');
        await vscode.commands.executeCommand('tsk.migrateMarkdownTasks', doc.uri);
        const lines = doc.getText().split('\n');

        assert.strictEqual(lines[0], '# the list', 'heading untouched');
        assert.match(
            lines[1] as string,
            new RegExp(`^- \\[ \\] alpha <!-- @id:[a-z0-9]+ @created:${esc(T1)} -->$`),
            'todo: created from the adding commit, no status stamp',
        );
        assert.match(
            lines[2] as string,
            new RegExp(
                `^- \\[x\\] beta <!-- @id:[a-z0-9]+ @created:${esc(T1)} @completed:${esc(T2)} -->$`,
            ),
            'md done [/] → tsk [x]; @completed = the flip commit, @created = the add',
        );
        assert.match(
            lines[3] as string,
            new RegExp(
                `^- \\[!\\] gamma <!-- @id:[a-z0-9]+ @created:${esc(T1)} @cancelled:${esc(T1)} -->$`,
            ),
            'md cancelled [x] → tsk [!]; born-cancelled stamps status = created',
        );
        assert.match(
            lines[4] as string,
            new RegExp(
                `^- \\[>\\] delta <!-- @id:[a-z0-9]+ @created:${esc(T1)} @moved:${esc(T1)} -->$`,
            ),
            'md moved [>>] → tsk [>], no @movedTo',
        );
        assert.ok(!(lines[4] as string).includes('@movedTo'), '[>>] migration adds no @movedTo');
        assert.match(
            lines[5] as string,
            new RegExp(`^- \\[n\\] memo <!-- @id:[a-z0-9]+ @created:${esc(T1)} -->$`),
            'note: created only',
        );
        assert.strictEqual(
            lines[6],
            '- [x](https://example.com) a link, not a task',
            'a [text](url) markdown link is NOT a task',
        );
        assert.strictEqual(lines[7], '- bare bullet', 'bare bullet untouched');
        assert.match(
            lines[8] as string,
            /^- \[x\] fresh <!-- @id:[a-z0-9]+ @created:[\d\-T:+]+ @completed:[\d\-T:+]+ -->$/,
            'an uncommitted line still migrates, stamped now',
        );

        const ids = doc.getText().match(/@id:([a-z0-9]+)/g) ?? [];
        assert.strictEqual(new Set(ids).size, ids.length, 'every generated @id is unique');
    });

    test('re-running is a no-op (idempotency: id-carrying lines are skipped)', async () => {
        const doc = await open('tasks.md');
        const before = doc.getText();
        await vscode.commands.executeCommand('tsk.migrateMarkdownTasks', doc.uri);
        assert.strictEqual(doc.getText(), before, 'second run changes nothing');
    });

    test('a (uri, line) invocation — the code-action path — migrates only that line', async () => {
        const doc = await open('single.md');
        await vscode.commands.executeCommand('tsk.migrateMarkdownTasks', doc.uri, 0);
        const lines = doc.getText().split('\n');
        assert.match(lines[0] as string, /@id:/, 'targeted line migrated');
        assert.strictEqual(lines[1], '- [ ] not this one', 'other lines untouched');
    });

    test('a non-empty selection limits the bulk migrate to its lines', async () => {
        const doc = await open('selection.md');
        const editor = vscode.window.activeTextEditor;
        assert.ok(editor);
        editor.selection = new vscode.Selection(0, 0, 1, 5); // lines 0-1
        await vscode.commands.executeCommand('tsk.migrateMarkdownTasks');
        const lines = doc.getText().split('\n');
        assert.match(lines[0] as string, /@id:/, 'selected line 0 migrated');
        assert.match(lines[1] as string, /@id:/, 'selected line 1 migrated');
        assert.strictEqual(lines[2], '- [ ] three', 'line outside the selection untouched');
    });

    test('a non-markdown document is refused without edits', async () => {
        const doc = await vscode.workspace.openTextDocument({
            content: '- [ ] tsk task',
            language: 'tsk',
        });
        await vscode.window.showTextDocument(doc);
        const before = doc.getText();
        await vscode.commands.executeCommand('tsk.migrateMarkdownTasks');
        assert.strictEqual(doc.getText(), before, 'tsk docs are not the migration surface');
    });

    test('the migrate code action is offered on md task lines (and not on migrated ones)', async () => {
        const doc = await open('selection.md');
        assert.ok(
            await queryActions(
                doc.uri,
                new vscode.Range(2, 0, 2, 0), // "- [ ] three" — still raw md
                'Migrate task to tsk format',
            ),
            'raw md task line offers the migrate action',
        );
        const actionsOnMigrated = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider',
            doc.uri,
            new vscode.Range(0, 0, 0, 0), // migrated by the selection test
        );
        assert.ok(
            !actionsOnMigrated?.some((a) => a.title === 'Migrate task to tsk format'),
            'an id-carrying line no longer offers it',
        );
    });

    // ── M4: move-from-md (the relocation pipeline) ─────────────────────────

    test('the Move action is offered on an id-carrying md line, not on raw md children', async () => {
        const doc = await open('move.md');
        assert.ok(
            await queryActions(
                doc.uri,
                new vscode.Range(0, 0, 0, 0), // the migrated parent (@id:mvtop1)
                'Move task to file…',
            ),
            'id-carrying md task offers Move',
        );
        const onRawChild = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider',
            doc.uri,
            new vscode.Range(1, 0, 1, 0), // "- [/] child done" — raw md, no @id
        );
        assert.ok(
            !onRawChild?.some((a) => a.title === 'Move task to file…'),
            'a raw (id-less) md line offers no Move',
        );
    });

    test('move from md converts raw md children on the way out, with git stamps', async () => {
        const doc = await open('move.md');
        const dst = vscode.Uri.file(join(repo, 'dst.tsk'));
        writeRepoFile('dst.tsk', '# destination\n');

        const win = vscode.window as unknown as { showQuickPick: unknown };
        const orig = win.showQuickPick;
        win.showQuickPick = async () => ({ label: 'dst.tsk', uri: dst });
        try {
            await vscode.commands.executeCommand('tsk.moveTaskToFile', doc.uri, 0);
        } finally {
            win.showQuickPick = orig;
        }

        const srcLines = doc.getText().split('\n');
        assert.match(
            srcLines[0] as string,
            /^- \[>\] parent done <!-- @id:[a-z0-9]+ @movedTo:mvtop1 @moved:[\d\-T:+]+ -->$/,
            'the md keeps a [>] breadcrumb pointing at the moved task',
        );
        assert.ok(!doc.getText().includes('child done'), 'children left the md');
        assert.strictEqual(srcLines[1], '- [ ] stays behind', 'the sibling below is untouched');

        const dstText = (await vscode.workspace.openTextDocument(dst)).getText();
        assert.ok(
            dstText.includes(
                `- [x] parent done <!-- @id:mvtop1 @created:${T1} @completed:${T1} -->`,
            ),
            'the parent moved verbatim, keeping its @id',
        );
        assert.match(
            dstText,
            new RegExp(
                `    - \\[x\\] child done <!-- @id:[a-z0-9]+ @created:${esc(T1)} @completed:${esc(T1)} -->`,
            ),
            'the raw md-done child was CONVERTED (md [/] → tsk [x]) with git stamps',
        );
        assert.match(
            dstText,
            new RegExp(
                `    - \\[>\\] child moved <!-- @id:[a-z0-9]+ @created:${esc(T1)} @moved:${esc(T1)} -->`,
            ),
            'the raw [>>] child became tsk [>] with @moved',
        );
        assert.ok(dstText.includes('    - loose note'), 'a bare bullet rides along untouched');
    });
});
