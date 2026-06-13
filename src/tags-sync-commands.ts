import * as vscode from 'vscode';
import { COMMANDS } from './constants';
import type { CacheService } from './lib/cache';
import type { Logger } from './lib/logger';
import { parseTagsYaml } from './lib/tags-config';
import { buildTagsAppendText, computeMissingTags } from './lib/tags-sync';
import { localDate } from './lib/time';
import type { TagsLoader } from './tags-loader';

/**
 * `tsk.addDiscoveredTags` ("Tsk: Add Discovered Tags to tags.yml") — find every
 * tag used on a workspace task that isn't yet declared in `tags.yml` and append
 * bare stub entries for them, under a dated header, so the user can fill in a
 * `description` / `parent`.
 *
 * Append-only: existing entries and comments are never rewritten. Scope is the
 * LITERAL discovered tags (`cache.listAllTags()`) — implicit `/`-parents are not
 * auto-added. A missing `tags.yml` is created; nothing-missing is a toast, not a
 * write. The `TagsLoader` watcher would reload on the write anyway, but we
 * `reload()` explicitly so completion / find-by-tag (and the e2e) see the stubs
 * deterministically.
 *
 * `deps.today` is injected so the header date is deterministic in tests.
 */
interface TagsSyncDeps {
    today: () => string;
}
const defaultTagsSyncDeps: TagsSyncDeps = { today: () => localDate() };

export function registerTagsSyncCommand(
    context: vscode.ExtensionContext,
    cache: CacheService,
    loader: TagsLoader,
    logger: Logger,
    deps: TagsSyncDeps = defaultTagsSyncDeps,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.addDiscoveredTags, () =>
            addDiscoveredTags(cache, loader, logger, deps),
        ),
    );
}

async function addDiscoveredTags(
    cache: CacheService,
    loader: TagsLoader,
    logger: Logger,
    deps: TagsSyncDeps,
): Promise<void> {
    const path = loader.getPath();
    if (!path) {
        void vscode.window.showInformationMessage(
            'Tsk: no tags.yml path is configured (open a workspace, or set tsk.tags.path).',
        );
        return;
    }
    const uri = vscode.Uri.file(path);

    // Current content: the editor buffer if the file is open (so a dirty
    // tags.yml isn't clobbered by a stale disk read), else from disk; a
    // missing file → empty text + we'll create it.
    let existingText = '';
    let doc: vscode.TextDocument | undefined;
    try {
        doc = await vscode.workspace.openTextDocument(uri);
        existingText = doc.getText();
    } catch {
        doc = undefined; // FileNotFound / unreadable → treat as a new file
    }

    const declared = parseTagsYaml(existingText);
    const missing = computeMissingTags(cache.listAllTags(), declared.keys());
    if (missing.length === 0) {
        void vscode.window.showInformationMessage(
            'Tsk: tags.yml already declares every discovered tag.',
        );
        logger.info(`${COMMANDS.addDiscoveredTags}: nothing to add.`);
        return;
    }

    const eol = doc?.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const appendText = buildTagsAppendText(existingText, missing, deps.today(), eol);

    const edit = new vscode.WorkspaceEdit();
    if (doc) {
        edit.insert(uri, doc.lineAt(doc.lineCount - 1).range.end, appendText);
    } else {
        // createFile-with-contents → one atomic resource edit (undoes cleanly).
        edit.createFile(uri, { ignoreIfExists: true, contents: Buffer.from(appendText, 'utf8') });
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
        void vscode.window.showWarningMessage('Tsk: could not write tags.yml.');
        return;
    }

    // Persist: tags.yml is a config file the user asked to populate, not a task
    // doc they're mid-edit on. Saving keeps the on-disk file (which the loader
    // re-reads) in step with the edit — so completion / find-by-tag surface the
    // stubs and a re-run stays idempotent rather than re-adding from a stale disk.
    await (await vscode.workspace.openTextDocument(uri)).save();
    await loader.reload();
    await revealFirstStub(uri, missing.length);
    void vscode.window.showInformationMessage(
        `Tsk: added ${missing.length} tag${missing.length === 1 ? '' : 's'} to tags.yml.`,
    );
    logger.info(`${COMMANDS.addDiscoveredTags}: added ${missing.length} tag(s) to ${path}`);
}

/** Open tags.yml and land the cursor at the end of the first appended `tag:` stub. */
async function revealFirstStub(uri: vscode.Uri, count: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    // The block sits at the file's tail: [header, stub×count, trailing empty
    // line] — so the first stub is `count` lines up from the final empty line.
    const line = Math.max(0, doc.lineCount - 1 - count);
    const pos = new vscode.Position(line, doc.lineAt(line).text.length);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}
