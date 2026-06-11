import { basename, dirname } from 'node:path';
import * as vscode from 'vscode';
import { COMMANDS, MIGRATE_MARKERS_KEY } from './constants';
import type { CacheService } from './lib/cache';
import { generateId } from './lib/ids';
import type { Logger } from './lib/logger';
import { deriveStamps, gitLineHistory, gitShowHead, mapDocLinesToHead } from './lib/md-git-history';
import {
    DEFAULT_MD_MARKER_MAP,
    type MdStamps,
    matchMdTask,
    migrateMdLine,
    validateMarkerMap,
} from './lib/md-migrate';
import { extractMetadata } from './lib/metadata';
import { localTimestamp } from './lib/time';

/**
 * `tsk.migrateMarkdownTasks` — convert Markdown task lines into tsk tasks IN
 * PLACE: remap each glyph through the `tsk.migrate.markers` vocabulary and
 * stamp `@id` + `@created` (+ the status timestamp), derived from the line's
 * git history (`md-git-history.ts`); lines git can't answer for are stamped
 * `now` and counted in the summary.
 *
 * Scope: a `(uri, line)` pair (the per-line code action) migrates one line; a
 * non-empty selection migrates the lines it touches; otherwise the whole
 * file. All derivation happens against the PRE-edit document, then ONE
 * `WorkspaceEdit` applies every line — a single undo step. Cancelling the
 * progress notification applies nothing.
 *
 * Also contributes the "Migrate task to tsk format" rewrite action on
 * id-less Markdown task lines. Already-migrated lines (carrying `@id`) are
 * skipped everywhere — the idempotency rule.
 */
interface MigrateDeps {
    generateId: () => string;
    now: () => string;
}
const defaultMigrateDeps: MigrateDeps = { generateId, now: localTimestamp };

const MARKDOWN_LANGUAGE_ID = 'markdown';

export function registerMdMigrateCommands(
    context: vscode.ExtensionContext,
    cache: CacheService,
    logger: Logger,
    deps: MigrateDeps = defaultMigrateDeps,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            COMMANDS.migrateMarkdownTasks,
            (uri?: vscode.Uri, line?: number) =>
                migrateMarkdownTasks(cache, logger, deps, uri, line),
        ),
        vscode.languages.registerCodeActionsProvider(
            { language: MARKDOWN_LANGUAGE_ID },
            { provideCodeActions: (document, range) => provideMigrateAction(document, range) },
            { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] },
        ),
    );
}

/** Read + validate the `tsk.migrate.markers` vocabulary (package.json default as fallback). */
function readMarkerMap(logger: Logger) {
    const raw = vscode.workspace
        .getConfiguration('tsk')
        .get<Record<string, string>>(MIGRATE_MARKERS_KEY, { ...DEFAULT_MD_MARKER_MAP });
    return validateMarkerMap(raw, (message) => logger.warn(message));
}

/** Offer "Migrate task to tsk format" on an id-less Markdown task line. */
function provideMigrateAction(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
): vscode.CodeAction[] | undefined {
    const lineNumber = range.start.line;
    const line = document.lineAt(lineNumber).text;
    // A silent matcher here — config problems surface when the command runs.
    const map = validateMarkerMap(
        vscode.workspace
            .getConfiguration('tsk')
            .get<Record<string, string>>(MIGRATE_MARKERS_KEY, { ...DEFAULT_MD_MARKER_MAP }),
    );
    if (!matchMdTask(line, map)) return undefined;
    if (extractMetadata(line).metadata.has('id')) return undefined;
    const action = new vscode.CodeAction(
        'Migrate task to tsk format',
        vscode.CodeActionKind.RefactorRewrite,
    );
    action.command = {
        command: COMMANDS.migrateMarkdownTasks,
        title: action.title,
        arguments: [document.uri, lineNumber],
    };
    return [action];
}

async function migrateMarkdownTasks(
    cache: CacheService,
    logger: Logger,
    deps: MigrateDeps,
    uriArg?: vscode.Uri,
    lineArg?: number,
): Promise<void> {
    // Source doc: from the code-action args, else the active editor.
    const editor = vscode.window.activeTextEditor;
    const doc = uriArg ? await vscode.workspace.openTextDocument(uriArg) : editor?.document;
    if (!doc || doc.languageId !== MARKDOWN_LANGUAGE_ID) {
        void vscode.window.showInformationMessage('Tsk: open a Markdown file to migrate tasks.');
        return;
    }

    // Scope: one line (code action) → the selection's lines → the whole file.
    let firstLine = 0;
    let lastLine = doc.lineCount - 1;
    if (lineArg !== undefined) {
        firstLine = lineArg;
        lastLine = lineArg;
    } else if (editor?.document === doc && !editor.selection.isEmpty) {
        firstLine = editor.selection.start.line;
        lastLine = editor.selection.end.line;
    }

    const map = readMarkerMap(logger);
    const docLines = doc.getText().split(/\r?\n/);

    // Candidates = md-task lines in scope without an @id; matched-but-id'd
    // lines are the "already tsk" count (idempotent re-runs report, not edit).
    const candidates: number[] = [];
    let alreadyTsk = 0;
    for (let i = firstLine; i <= lastLine && i < docLines.length; i++) {
        if (!matchMdTask(docLines[i] as string, map)) continue;
        if (extractMetadata(docLines[i] as string).metadata.has('id')) alreadyTsk++;
        else candidates.push(i);
    }
    if (candidates.length === 0) {
        void vscode.window.showInformationMessage(
            alreadyTsk > 0
                ? 'Tsk: every Markdown task here is already migrated.'
                : 'Tsk: no Markdown tasks to migrate here.',
        );
        return;
    }

    // Derive stamps against the PRE-edit doc. -L addresses HEAD line numbers,
    // so map doc lines to HEAD by content first; unmatched (uncommitted /
    // edited) lines and every git failure fall back to `now`.
    const fileDir = doc.uri.scheme === 'file' ? dirname(doc.uri.fsPath) : undefined;
    const fileName = fileDir ? basename(doc.uri.fsPath) : undefined;
    const stampsByLine = new Map<number, MdStamps>();
    let fallbacks = 0;

    const cancelled = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Tsk: deriving task history from git…',
            cancellable: true,
        },
        async (progress, token) => {
            const headLines = fileDir && fileName ? await gitShowHead(fileDir, fileName) : null;
            const headMap = headLines ? mapDocLinesToHead(docLines, headLines) : null;
            let done = 0;
            for (const lineNo of candidates) {
                if (token.isCancellationRequested) return true;
                const headLine = headMap?.[lineNo];
                const entries =
                    headLine !== null && headLine !== undefined && fileDir && fileName
                        ? await gitLineHistory(fileDir, fileName, headLine + 1)
                        : null;
                const stamps =
                    entries && entries.length > 0 ? deriveStamps(entries, map) : undefined;
                if (stamps) {
                    stampsByLine.set(lineNo, stamps);
                } else {
                    // No git answer → stamp now, for the status too — a [x]
                    // without @completed would defy tsk's own toggles, which
                    // always timestamp a transition.
                    const now = deps.now();
                    stampsByLine.set(lineNo, { created: now, status: now });
                    fallbacks++;
                }
                done++;
                progress.report({ message: `${done}/${candidates.length}` });
            }
            return false;
        },
    );
    if (cancelled) {
        logger.info(`${COMMANDS.migrateMarkdownTasks}: cancelled — nothing applied.`);
        return;
    }

    // Fresh ids, guarded against the cache and this run's own batch.
    const used = new Set<string>();
    const freshId = (): string => {
        let id = deps.generateId();
        while (used.has(id) || cache.lookupById(id) !== undefined) id = deps.generateId();
        used.add(id);
        return id;
    };

    const edit = new vscode.WorkspaceEdit();
    for (const lineNo of candidates) {
        const migrated = migrateMdLine(
            docLines[lineNo] as string,
            map,
            stampsByLine.get(lineNo) as MdStamps,
            freshId(),
        );
        if (migrated === null) continue; // unreachable for a pre-filtered candidate
        edit.replace(
            doc.uri,
            new vscode.Range(lineNo, 0, lineNo, doc.lineAt(lineNo).text.length),
            migrated,
        );
    }

    if (!(await vscode.workspace.applyEdit(edit))) {
        void vscode.window.showWarningMessage('Tsk: the migration edit could not be applied.');
        return;
    }

    const parts = [`migrated ${candidates.length} task${candidates.length === 1 ? '' : 's'}`];
    if (alreadyTsk > 0) parts.push(`${alreadyTsk} already tsk`);
    if (fallbacks > 0) parts.push(`${fallbacks} stamped now (no git history)`);
    void vscode.window.showInformationMessage(`Tsk: ${parts.join(' · ')}.`);
    logger.info(`${COMMANDS.migrateMarkdownTasks}: ${parts.join(', ')} in ${doc.uri.fsPath}`);
}
