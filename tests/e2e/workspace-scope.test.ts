import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';

/**
 * The cache holds the workspace's `.tsk` files as the initial scan lists them
 * (`git ls-files`), and the file watcher keeps it there: a
 * deleted folder takes its files with it, and a nested repository's files,
 * which git doesn't list, never come in. A forked agent's worktree broke both:
 * its `claude.tsk` was indexed beside the real one, then outlived the worktree.
 * Each test works in folders of its own at the workspace's root, removed after.
 */
suite('which .tsk files the cache holds', () => {
    let api: TskExtensionApi;
    let root: string;
    const made: string[] = [];

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        api = await ext.activate();
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'expected a workspace folder');
        root = folder.uri.fsPath;
    });

    suiteTeardown(async () => {
        for (const d of made) fs.rmSync(d, { recursive: true, force: true });
        // Later suites count the fixture's files: wait for these to go.
        await until(() => api.findTaskById('scopeplain1') === undefined, 'the plain folder to go');
    });

    async function until(check: () => boolean, what: string, ms = 10_000, nudge?: () => void) {
        const end = Date.now() + ms;
        let next = Date.now() + 1000;
        while (!check()) {
            if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
            if (nudge && Date.now() > next) {
                nudge();
                next = Date.now() + 1000;
            }
            await new Promise((r) => setTimeout(r, 50));
        }
    }
    /** Write a `.tsk` file and wait for it to come in, writing it again each second: a window's watcher can start late. */
    async function writeIn(file: string, text: string, id: string) {
        const write = () => fs.writeFileSync(file, text);
        write();
        await until(() => api.findTaskById(id) !== undefined, `${id} to come in`, 15_000, write);
    }
    const folder = (name: string) => {
        const d = path.join(root, name);
        made.push(d);
        fs.mkdirSync(d);
        return d;
    };

    test("a deleted folder's tasks leave the cache", async () => {
        const d = folder('scope-gone');
        await writeIn(path.join(d, 'a.tsk'), '- [ ] going <!-- @id:scopegone1 -->\n', 'scopegone1');
        fs.rmSync(d, { recursive: true });
        await until(
            () => api.findTaskById('scopegone1') === undefined,
            "the deleted folder's task to leave the cache",
        );
    });

    test("a nested repository's .tsk files stay out, as git leaves them out of its listing", async () => {
        const nested = folder('scope-nested');
        execFileSync('git', ['init', '-q', nested]);
        fs.writeFileSync(path.join(nested, 'claude.tsk'), '- [ ] a copy <!-- @id:scopenest1 -->\n');
        // A plain file after it: once that one is in, the watcher has had both.
        const plain = folder('scope-plain');
        await writeIn(
            path.join(plain, 'b.tsk'),
            '- [ ] here <!-- @id:scopeplain1 -->\n',
            'scopeplain1',
        );
        // The nested one's check may still be in flight.
        await new Promise((r) => setTimeout(r, 500));
        assert.strictEqual(api.findTaskById('scopenest1'), undefined);
    });
});
