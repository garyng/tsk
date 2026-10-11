import * as nodeFs from 'node:fs';
import { dirname, relative } from 'node:path';
import * as vscode from 'vscode';
import { COMMANDS, EDITOR_CHANGE_DEBOUNCE_KEY, TSK_LANGUAGE_ID } from './constants';
import type { DiagnosticsManager } from './diagnostics-manager';
import { isTskDocument } from './editor-guards';
import { cancelDebounced, scheduleDebounced } from './lib/debounce';
import type { Logger } from './lib/logger';
import {
    buildWikiLinkInsert,
    danglingWikiLinks,
    wikiLinkPrefixAt,
    wikiLinkSpans,
    wikiPathCandidates,
} from './lib/wiki-link';
import type { WorkspaceFiles } from './workspace-files';

/**
 * The VS Code layer for `[[wiki links]]`: ctrl+click to open, `[`-triggered
 * path completion, and `tsk.insertWikiLink` (pick a file, get a link). The
 * pure matching lives in `lib/wiki-link.ts`.
 *
 * Unlike `autolinks-provider.ts`, this provider needs no dispose+re-register
 * lifecycle: a wiki link's target depends on no setting, so VS Code's link
 * cache can never go stale against a settings change. Nothing
 * here is configurable: the completion candidates are every file git doesn't
 * ignore, recomputed per request.
 */

const TRIGGER_CHARACTER = '[';

/** The first workspace folder's fsPath, or `undefined` (single-file / untitled). */
function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** The directory of `document`, or `undefined` for a non-file scheme (untitled). */
function documentDir(document: vscode.TextDocument): string | undefined {
    return document.uri.scheme === 'file' ? dirname(document.uri.fsPath) : undefined;
}

/**
 * The first candidate path that exists on disk, or `undefined` for a dangling
 * link. Synchronous and uncached on purpose: `existsSync` costs a few µs, files
 * carry a handful of links, and caching would need a watcher over `**` to
 * invalidate — strictly more expensive than the stats it saves.
 */
function resolveTarget(
    path: string,
    root: string | undefined,
    docDir: string | undefined,
): vscode.Uri | undefined {
    for (const candidate of wikiPathCandidates(path, root, docDir)) {
        // `existsSync` never throws — a malformed path (NUL byte, over-long
        // component) just returns false, which is a dangling link, not a crash.
        if (nodeFs.existsSync(candidate)) return vscode.Uri.file(candidate);
    }
    return undefined;
}

/** Every workspace file the completion / picker may offer. */
async function listCandidateFiles(files: WorkspaceFiles | undefined): Promise<vscode.Uri[]> {
    // Every non-ignored file in the workspace, with no type filter. `[[…]]`
    // resolution never consulted a glob — typing any path has always worked —
    // so narrowing what's *offered* by file type would only hide useful
    // targets. Keeping `node_modules` and build output out of the picker is
    // what the gitignore-backed listing is for.
    return (await files?.all('**/*')) ?? [];
}

/** Workspace-relative, forward-slashed — the form links are written in. */
function toRelative(uri: vscode.Uri, root: string | undefined): string {
    if (root === undefined) return uri.fsPath;
    return relative(root, uri.fsPath).split('\\').join('/');
}

export function registerWikiLinks(
    context: vscode.ExtensionContext,
    diagnostics: DiagnosticsManager,
    files: WorkspaceFiles | undefined,
    logger: Logger,
): void {
    registerDanglingDiagnostics(context, diagnostics);
    context.subscriptions.push(
        vscode.languages.registerDocumentLinkProvider(
            { language: TSK_LANGUAGE_ID },
            { provideDocumentLinks: (document) => provideLinks(document) },
        ),
        vscode.languages.registerCompletionItemProvider(
            { language: TSK_LANGUAGE_ID },
            {
                provideCompletionItems: (document, position) =>
                    provideCompletions(document, position, files),
            },
            TRIGGER_CHARACTER,
        ),
        vscode.commands.registerCommand(COMMANDS.insertWikiLink, () =>
            insertWikiLink(files, logger),
        ),
    );
}

function provideLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const root = workspaceRoot();
    const docDir = documentDir(document);
    const links: vscode.DocumentLink[] = [];
    for (let line = 0; line < document.lineCount; line++) {
        for (const span of wikiLinkSpans(document.lineAt(line).text)) {
            const range = new vscode.Range(line, span.startCol, line, span.endCol);
            const target = resolveTarget(span.path, root, docDir);
            if (target === undefined) {
                // Still a link, so the tooltip can explain itself — a span that
                // simply isn't clickable looks broken with no reason given.
                const dangling = new vscode.DocumentLink(range);
                dangling.tooltip = `tsk: no file found for "${span.path}"`;
                links.push(dangling);
                continue;
            }
            const link = new vscode.DocumentLink(range, target);
            link.tooltip = target.fsPath;
            links.push(link);
        }
    }
    return links;
}

async function provideCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
    files: WorkspaceFiles | undefined,
): Promise<vscode.CompletionItem[] | undefined> {
    const line = document.lineAt(position.line).text;
    // The `[` trigger also fires on the first bracket of a pair and inside a
    // `- [ ]` marker; this is the gate that keeps completions out of both.
    const open = wikiLinkPrefixAt(line, position.character);
    if (open === null) return undefined;

    const root = workspaceRoot();
    const replaceRange = new vscode.Range(
        position.line,
        open.startCol,
        position.line,
        position.character,
    );
    const items: vscode.CompletionItem[] = [];
    for (const uri of await listCandidateFiles(files)) {
        const rel = toRelative(uri, root);
        const item = new vscode.CompletionItem(basenameOf(rel), vscode.CompletionItemKind.File);
        item.detail = dirname(rel) === '.' ? undefined : dirname(rel);
        item.insertText = rel;
        // The label is the basename, but the user types a PATH (`notes/20…`),
        // so filtering has to run against the full relative path or nothing
        // matches after the first slash.
        item.filterText = rel;
        item.range = replaceRange;
        items.push(item);
    }
    return items;
}

function basenameOf(relPath: string): string {
    const parts = relPath.split('/');
    return parts[parts.length - 1] as string;
}

async function insertWikiLink(
    workspaceFiles: WorkspaceFiles | undefined,
    logger: Logger,
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        logger.debug(`${COMMANDS.insertWikiLink}: no active editor`);
        return;
    }
    const root = workspaceRoot();
    const files = await listCandidateFiles(workspaceFiles);
    if (files.length === 0) {
        void vscode.window.showInformationMessage(
            'Tsk: no linkable files found in this workspace.',
        );
        return;
    }

    const picked = await vscode.window.showQuickPick(
        files
            .map((uri) => {
                const rel = toRelative(uri, root);
                return { label: basenameOf(rel), description: dirname(rel), rel };
            })
            .sort((a, b) => a.rel.localeCompare(b.rel)),
        { placeHolder: 'Link to which file?', matchOnDescription: true },
    );
    if (!picked) {
        logger.debug(`${COMMANDS.insertWikiLink}: picker cancelled`);
        return;
    }

    const { selection, document } = editor;
    const edit = new vscode.WorkspaceEdit();
    if (selection.isEmpty) {
        const line = document.lineAt(selection.active.line).text;
        const insert = buildWikiLinkInsert(line, selection.active.character, picked.rel);
        edit.replace(
            document.uri,
            new vscode.Range(
                selection.active.line,
                insert.startCol,
                selection.active.line,
                insert.endCol,
            ),
            insert.text,
        );
    } else {
        // A selection is an explicit "replace this with the link".
        edit.replace(document.uri, selection, `[[${picked.rel}]]`);
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
        void vscode.window.showWarningMessage('Tsk: could not insert the link.');
        return;
    }
    logger.info(`${COMMANDS.insertWikiLink}: inserted [[${picked.rel}]]`);
}

/**
 * Squiggle every `[[…]]` that resolves to nothing, for OPEN `.tsk` documents.
 *
 * Open documents only, and the reason is worth knowing: the obvious home for
 * this was the cache rescan tail, but a warm start SKIPS unchanged files (their
 * text is never read), so link warnings would silently be missing in the most
 * common case — reopening the window. Covering unopened files needs link spans
 * persisted in `cache.db`, which is a schema change. What bites in practice is
 * a typo in a link you are looking at, and that is exactly what this covers.
 *
 * The provider's hover stays the always-fresh signal: a diagnostic computed on
 * edit cannot notice the target being CREATED later (the workspace watcher
 * only watches `**\/*.tsk`), so a squiggle can linger until the linking file is
 * next touched.
 */
function registerDanglingDiagnostics(
    context: vscode.ExtensionContext,
    diagnostics: DiagnosticsManager,
): void {
    const timers = new Map<string, NodeJS.Timeout>();

    const refresh = (document: vscode.TextDocument): void => {
        if (!isTskDocument(document)) return;
        const root = workspaceRoot();
        const docDir = documentDir(document);
        const lines = document.getText().split(/\r?\n/);
        diagnostics.setLinkWarnings(
            document.uri.toString(),
            danglingWikiLinks(lines, (path) => resolveTarget(path, root, docDir) !== undefined),
        );
    };

    for (const document of vscode.workspace.textDocuments) refresh(document);

    context.subscriptions.push(
        new vscode.Disposable(() => {
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
        }),
        vscode.workspace.onDidOpenTextDocument((document) => refresh(document)),
        vscode.workspace.onDidSaveTextDocument((document) => refresh(document)),
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (!isTskDocument(event.document)) return;
            scheduleDebounced(timers, event.document.uri.toString(), readDebounceMs(), () =>
                refresh(event.document),
            );
        }),
        vscode.workspace.onDidCloseTextDocument((document) => {
            if (!isTskDocument(document)) return;
            const key = document.uri.toString();
            cancelDebounced(timers, key);
            diagnostics.setLinkWarnings(key, []);
        }),
    );
}

/** The same debounce the decoration / rescan paths use, so typing feels consistent. */
function readDebounceMs(): number {
    return vscode.workspace.getConfiguration('tsk').get<number>(EDITOR_CHANGE_DEBOUNCE_KEY, 300);
}
