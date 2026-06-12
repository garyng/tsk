import { basename, dirname } from 'node:path';
import * as vscode from 'vscode';
import { COMMANDS, MIGRATE_MARKERS_KEY } from './constants';
import type { CacheService } from './lib/cache';
import { generateId } from './lib/ids';
import type { Logger } from './lib/logger';
import type { Marker } from './lib/markers';
import { gitFileLineStamps, gitShowHead, mapDocLinesToHead } from './lib/md-git-history';
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
 * Also contributes the id-less-line code actions — "Migrate task to tsk
 * format" (rewrite) and "Send task to tsk file…" (move, handled in
 * `move-task-commands.ts`). Already-migrated lines (carrying `@id`) are
 * skipped everywhere — the idempotency rule.
 */
interface MigrateDeps {
    generateId: () => string;
    now: () => string;
}
const defaultMigrateDeps: MigrateDeps = { generateId, now: localTimestamp };

export const MARKDOWN_LANGUAGE_ID = 'markdown';

/** Read + validate the `tsk.migrate.markers` vocabulary (package.json default as fallback). */
export function readMigrateMarkerMap(logger?: Logger) {
    const raw = vscode.workspace
        .getConfiguration('tsk')
        .get<Record<string, string>>(MIGRATE_MARKERS_KEY, { ...DEFAULT_MD_MARKER_MAP });
    return validateMarkerMap(raw, logger ? (message) => logger.warn(message) : undefined);
}

/** Fresh-id factory re-rolling against the cache and everything it already handed out. */
export function makeGuardedIdFactory(cache: CacheService, generate: () => string): () => string {
    const used = new Set<string>();
    return () => {
        let id = generate();
        while (used.has(id) || cache.lookupById(id) !== undefined) id = generate();
        used.add(id);
        return id;
    };
}

/**
 * Derive {@link MdStamps} for the given doc lines from git history — the
 * shared derivation under migrate, move-from-md, and send. Maps the (possibly
 * dirty) doc to HEAD line numbers first (the patch replay tracks HEAD's line
 * numbers), then makes ONE streamed `git log -p` pass for the whole file
 * ({@link gitFileLineStamps} — killed early once every line resolves).
 * Unmatched lines and anything git can't answer stamp
 * `created = status = now` (a `[x]` without `@completed` would defy tsk's own
 * toggles) and count as `fallbacks`. Honors an optional cancellation token —
 * when it fires, `cancelled: true` returns and the caller applies nothing.
 */
export async function deriveStampsForDocLines(
    doc: vscode.TextDocument,
    docLines: readonly string[],
    lineNos: readonly number[],
    map: ReadonlyMap<string, Marker>,
    now: () => string,
    token?: vscode.CancellationToken,
    onProgress?: (message: string) => void,
): Promise<{ stamps: Map<number, MdStamps>; fallbacks: number; cancelled: boolean }> {
    const fileDir = doc.uri.scheme === 'file' ? dirname(doc.uri.fsPath) : undefined;
    const fileName = fileDir ? basename(doc.uri.fsPath) : undefined;
    const stamps = new Map<number, MdStamps>();
    let fallbacks = 0;

    const headLines = fileDir && fileName ? await gitShowHead(fileDir, fileName) : null;
    const headMap = headLines ? mapDocLinesToHead(docLines, headLines) : null;

    // Doc line → 1-based HEAD line, for the lines that map (the rest fall back).
    const docToHead = new Map<number, number>();
    for (const lineNo of lineNos) {
        const headLine = headMap?.[lineNo];
        if (headLine !== null && headLine !== undefined) docToHead.set(lineNo, headLine + 1);
    }

    let derived: Map<number, MdStamps> | undefined;
    if (headLines && fileDir && fileName && docToHead.size > 0) {
        const run = await gitFileLineStamps(
            fileDir,
            fileName,
            headLines,
            [...docToHead.values()],
            map,
            {
                isCancelled: () => token?.isCancellationRequested ?? false,
                onProgress: (resolved, total, commits) =>
                    onProgress?.(`${resolved}/${total} · ${commits} commits scanned`),
            },
        );
        if (run?.cancelled) return { stamps, fallbacks, cancelled: true };
        derived = run?.stamps;
    }
    // A cancel that lands outside the git pass (while `gitShowHead` awaited,
    // or on the no-git path) must also apply nothing — without this check the
    // fallback loop below would stamp everything `now` despite the cancel.
    if (token?.isCancellationRequested) return { stamps, fallbacks, cancelled: true };

    for (const lineNo of lineNos) {
        const headLine = docToHead.get(lineNo);
        const lineStamps = headLine !== undefined ? derived?.get(headLine) : undefined;
        if (lineStamps) {
            stamps.set(lineNo, lineStamps);
        } else {
            const ts = now();
            stamps.set(lineNo, { created: ts, status: ts });
            fallbacks++;
        }
    }
    return { stamps, fallbacks, cancelled: false };
}

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
            {
                providedCodeActionKinds: [
                    vscode.CodeActionKind.RefactorRewrite,
                    vscode.CodeActionKind.RefactorMove,
                ],
            },
        ),
    );
}

/**
 * Offer the two id-less-md-task actions: "Migrate task to tsk format"
 * (convert in place) and "Send task to tsk file…" (convert + relocate in one
 * step). Id-carrying lines get neither — those offer the plain Move (from
 * `move-task-commands.ts`'s provider) instead.
 */
function provideMigrateAction(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
): vscode.CodeAction[] | undefined {
    const lineNumber = range.start.line;
    const line = document.lineAt(lineNumber).text;
    // A silent map read — config problems surface when the command runs.
    const map = readMigrateMarkerMap();
    if (!matchMdTask(line, map)) return undefined;
    if (extractMetadata(line).metadata.has('id')) return undefined;
    const migrate = new vscode.CodeAction(
        'Migrate task to tsk format',
        vscode.CodeActionKind.RefactorRewrite,
    );
    migrate.command = {
        command: COMMANDS.migrateMarkdownTasks,
        title: migrate.title,
        arguments: [document.uri, lineNumber],
    };
    const send = new vscode.CodeAction(
        'Send task to tsk file…',
        vscode.CodeActionKind.RefactorMove,
    );
    send.command = {
        command: COMMANDS.sendMarkdownTaskToFile,
        title: send.title,
        arguments: [document.uri, lineNumber],
    };
    return [migrate, send];
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

    const map = readMigrateMarkerMap(logger);
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

    // Derive stamps against the PRE-edit doc (one edit at the end keeps the
    // doc→HEAD line mapping valid, makes cancel-applies-nothing true, and one
    // undo step).
    const derived = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Tsk: deriving task history from git…',
            cancellable: true,
        },
        (progress, token) =>
            deriveStampsForDocLines(doc, docLines, candidates, map, deps.now, token, (message) =>
                progress.report({ message }),
            ),
    );
    if (derived.cancelled) {
        logger.info(`${COMMANDS.migrateMarkdownTasks}: cancelled — nothing applied.`);
        return;
    }
    const fallbacks = derived.fallbacks;

    const freshId = makeGuardedIdFactory(cache, deps.generateId);
    const edit = new vscode.WorkspaceEdit();
    for (const lineNo of candidates) {
        const migrated = migrateMdLine(
            docLines[lineNo] as string,
            map,
            derived.stamps.get(lineNo) as MdStamps,
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
