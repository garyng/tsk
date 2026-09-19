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
    matchMdBareBullet,
    matchMdTask,
    migrateMdBullet,
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
 * `tsk.migrateMarkdownBullets` is the same machinery pointed at BARE
 * bullets — a `- aaaa` with no checkbox becomes a tsk todo. It's a separate
 * command on purpose: md files are mostly prose bullets, so the task
 * migration must never touch them, and only an explicit invocation should.
 *
 * Also contributes the id-less-line code actions — "Migrate task to tsk
 * format" / "Migrate bullet to tsk todo" (rewrite) and "Send task to tsk
 * file…" (move, handled in `move-task-commands.ts`). Already-migrated lines
 * (carrying `@id`) are skipped everywhere — the idempotency rule.
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
                runMdMigration(MIGRATE_TASKS_SPEC, cache, logger, deps, uri, line),
        ),
        vscode.commands.registerCommand(
            COMMANDS.migrateMarkdownBullets,
            (uri?: vscode.Uri, line?: number) =>
                runMdMigration(MIGRATE_BULLETS_SPEC, cache, logger, deps, uri, line),
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
 * Offer the id-less-line actions. An md TASK gets two: "Migrate task to tsk
 * format" (convert in place) and "Send task to tsk file…" (convert +
 * relocate in one step). A bare BULLET gets one: "Migrate bullet to tsk
 * todo". Id-carrying lines get none — those offer the plain Move (from
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
    if (extractMetadata(line).metadata.has('id')) return undefined;
    if (!matchMdTask(line, map)) {
        // Not a task — a bare bullet gets the one-line todo conversion
        // instead. No `Send…` counterpart: send relocates a task BLOCK, and a
        // bullet isn't one.
        if (!matchMdBareBullet(line)) return undefined;
        const toTodo = new vscode.CodeAction(
            'Migrate bullet to tsk todo',
            vscode.CodeActionKind.RefactorRewrite,
        );
        toTodo.command = {
            command: COMMANDS.migrateMarkdownBullets,
            title: toTodo.title,
            arguments: [document.uri, lineNumber],
        };
        return [toTodo];
    }
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

/**
 * The per-command half of an in-place migration: which lines are candidates,
 * how each one is rewritten, and how the run is announced. Everything else —
 * scope resolution, the `@id` idempotency rule, git derivation, the single
 * `WorkspaceEdit`, the summary — is shared by {@link runMdMigration}.
 */
interface MigrationSpec {
    commandId: string;
    /** Candidate test, BEFORE the shared id-less rule is applied. */
    matches: (line: string, map: ReadonlyMap<string, Marker>) => boolean;
    /** Rewrite one candidate; `null` is unreachable for a pre-filtered line. */
    rewrite: (
        line: string,
        map: ReadonlyMap<string, Marker>,
        stamps: MdStamps,
        id: string,
    ) => string | null;
    /** Singular noun for the summary ("task" / "bullet"). */
    noun: string;
    /** Shown when the scope holds no candidates at all. */
    emptyMessage: string;
    /** Shown when every candidate in scope already carries an `@id`. */
    allMigratedMessage: string;
    /**
     * Ask before a WHOLE-FILE run (selection scope and the single-line code
     * action always apply silently). Set for the bullet command: converting
     * every prose bullet in a file is the one genuinely destructive outcome
     * here, and the easiest to trigger by accident. The task command needs no
     * gate — its matcher only ever sees bracketed task lines.
     */
    confirmWholeFile?: boolean;
}

async function runMdMigration(
    spec: MigrationSpec,
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
    let wholeFile = true;
    if (lineArg !== undefined) {
        firstLine = lineArg;
        lastLine = lineArg;
        wholeFile = false;
    } else if (editor?.document === doc && !editor.selection.isEmpty) {
        firstLine = editor.selection.start.line;
        lastLine = editor.selection.end.line;
        wholeFile = false;
    }

    const map = readMigrateMarkerMap(logger);
    const docLines = doc.getText().split(/\r?\n/);

    // Candidates = matching lines in scope without an @id; matched-but-id'd
    // lines are the "already tsk" count (idempotent re-runs report, not edit).
    const candidates: number[] = [];
    let alreadyTsk = 0;
    for (let i = firstLine; i <= lastLine && i < docLines.length; i++) {
        if (!spec.matches(docLines[i] as string, map)) continue;
        if (extractMetadata(docLines[i] as string).metadata.has('id')) alreadyTsk++;
        else candidates.push(i);
    }
    if (candidates.length === 0) {
        void vscode.window.showInformationMessage(
            alreadyTsk > 0 ? spec.allMigratedMessage : spec.emptyMessage,
        );
        return;
    }

    if (spec.confirmWholeFile === true && wholeFile) {
        const plural = candidates.length === 1 ? '' : 's';
        const choice = await vscode.window.showWarningMessage(
            `Tsk: convert ${candidates.length} bare bullet${plural} in ${basename(doc.uri.fsPath)} to todos?`,
            { modal: true, detail: 'Select lines first to convert only part of the file.' },
            'Convert',
        );
        if (choice !== 'Convert') {
            logger.info(`${spec.commandId}: declined at the whole-file confirmation.`);
            return;
        }
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
        logger.info(`${spec.commandId}: cancelled — nothing applied.`);
        return;
    }
    const fallbacks = derived.fallbacks;

    const freshId = makeGuardedIdFactory(cache, deps.generateId);
    const edit = new vscode.WorkspaceEdit();
    for (const lineNo of candidates) {
        const migrated = spec.rewrite(
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

    const plural = candidates.length === 1 ? '' : 's';
    const parts = [`migrated ${candidates.length} ${spec.noun}${plural}`];
    if (alreadyTsk > 0) parts.push(`${alreadyTsk} already tsk`);
    if (fallbacks > 0) parts.push(`${fallbacks} stamped now (no git history)`);
    void vscode.window.showInformationMessage(`Tsk: ${parts.join(' · ')}.`);
    logger.info(`${spec.commandId}: ${parts.join(', ')} in ${doc.uri.fsPath}`);
}

const MIGRATE_TASKS_SPEC: MigrationSpec = {
    commandId: COMMANDS.migrateMarkdownTasks,
    matches: (line, map) => matchMdTask(line, map) !== null,
    rewrite: (line, map, stamps, id) => migrateMdLine(line, map, stamps, id),
    noun: 'task',
    emptyMessage: 'Tsk: no Markdown tasks to migrate here.',
    allMigratedMessage: 'Tsk: every Markdown task here is already migrated.',
};

const MIGRATE_BULLETS_SPEC: MigrationSpec = {
    commandId: COMMANDS.migrateMarkdownBullets,
    // The marker map is irrelevant to a bare bullet — it has no glyph. It
    // still rides the shared signature so both specs share one runner.
    matches: (line) => matchMdBareBullet(line) !== null,
    rewrite: (line, _map, stamps, id) => migrateMdBullet(line, stamps, id),
    noun: 'bullet',
    emptyMessage: 'Tsk: no bare Markdown bullets to convert here.',
    allMigratedMessage: 'Tsk: every bullet here already carries an @id.',
    confirmWholeFile: true,
};
