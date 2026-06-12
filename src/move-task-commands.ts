import * as vscode from 'vscode';
import { COMMANDS, TSK_LANGUAGE_ID } from './constants';
import { isTskDocument } from './editor-guards';
import type { CacheService } from './lib/cache';
import { generateId } from './lib/ids';
import type { Logger } from './lib/logger';
import type { Marker } from './lib/markers';
import { type MdStamps, matchMdTask, prepareMdBlockForTsk } from './lib/md-migrate';
import { extractMetadata } from './lib/metadata';
import {
    buildAppendText,
    buildMoveStub,
    computeTaskBlockRange,
    dedentBlock,
} from './lib/move-task-logic';
import { parseLine } from './lib/parser';
import { localTimestamp } from './lib/time';
import {
    deriveStampsForDocLines,
    MARKDOWN_LANGUAGE_ID,
    makeGuardedIdFactory,
    readMigrateMarkerMap,
} from './md-migrate-commands';

/**
 * `tsk.moveTaskToFile` — relocate the task under the cursor, together with its
 * indented sub-block, to another `.tsk` file (existing or newly created), and
 * leave a `[>]` breadcrumb in the source. The relocated task keeps its `@id`, so
 * every reference resolves at the new location after the post-edit rescan (the
 * occurrence-store makes id→location lookup file-independent).
 *
 * Also contributes a `Refactor` code action ("Move task to file…") on any task
 * line with an `@id`, deferred to the command (the destination QuickPick is
 * interactive, so it can only run at click time).
 *
 * `deps` is injected for tests; the default wires the real nanoid + timestamp.
 */
interface MoveDeps {
    generateId: () => string;
    now: () => string;
}
const defaultMoveDeps: MoveDeps = { generateId, now: localTimestamp };

interface TargetItem extends vscode.QuickPickItem {
    uri?: vscode.Uri;
    newFile?: boolean;
}

export function registerMoveTaskCommand(
    context: vscode.ExtensionContext,
    logger: Logger,
    cache: CacheService,
    deps: MoveDeps = defaultMoveDeps,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            COMMANDS.moveTaskToFile,
            (uri?: vscode.Uri, line?: number) => moveTaskToFile(deps, cache, logger, uri, line),
        ),
        // Markdown too: an id-carrying (already-migrated) md task moves the
        // same way — its raw md descendants are auto-converted on the way out.
        vscode.languages.registerCodeActionsProvider(
            [{ language: TSK_LANGUAGE_ID }, { language: MARKDOWN_LANGUAGE_ID }],
            { provideCodeActions: provideMoveAction },
            { providedCodeActionKinds: [vscode.CodeActionKind.RefactorMove] },
        ),
    );
}

/** Offer "Move task to file…" on a task line that already carries an `@id`. */
function provideMoveAction(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
): vscode.CodeAction[] | undefined {
    const lineNumber = range.start.line;
    const parsed = parseLine(document.lineAt(lineNumber).text);
    if (!parsed?.metadata.get('id')) return undefined;
    const action = new vscode.CodeAction('Move task to file…', vscode.CodeActionKind.RefactorMove);
    action.command = {
        command: COMMANDS.moveTaskToFile,
        title: action.title,
        arguments: [document.uri, lineNumber],
    };
    return [action];
}

async function moveTaskToFile(
    deps: MoveDeps,
    cache: CacheService,
    logger: Logger,
    uriArg?: vscode.Uri,
    lineArg?: number,
): Promise<void> {
    // Source doc + task line: from the code-action args, else the active editor.
    const editor = vscode.window.activeTextEditor;
    let doc: vscode.TextDocument;
    let taskLine: number;
    if (uriArg && lineArg !== undefined) {
        doc = await vscode.workspace.openTextDocument(uriArg);
        taskLine = lineArg;
    } else if (
        editor &&
        (isTskDocument(editor.document) || editor.document.languageId === MARKDOWN_LANGUAGE_ID)
    ) {
        doc = editor.document;
        taskLine = editor.selection.active.line;
    } else {
        return;
    }

    const task = parseLine(doc.lineAt(taskLine).text);
    if (!task) {
        void vscode.window.showInformationMessage('Tsk: the cursor is not on a task line.');
        return;
    }
    if (!task.metadata.get('id')) {
        void vscode.window.showInformationMessage(
            'Tsk: add an @id to the task first ("Add missing id"), then move it.',
        );
        return;
    }

    // The task's block (task line + its indented sub-items).
    const lines = doc.getText().split(/\r?\n/);
    const { start, end } = computeTaskBlockRange(lines, taskLine, resolveTabSize());
    let blockLines: readonly string[] = lines.slice(start, end + 1);

    // Markdown source: convert the block's id-less md-task descendants to tsk
    // BEFORE they travel — an un-remapped md [/]/[x] line landing in a .tsk
    // file would be misread by the glyph collision (md-done [/] = tsk
    // in-progress). Stamps derive from git like the migrate command's.
    if (doc.languageId === MARKDOWN_LANGUAGE_ID) {
        const converted = await convertBlocks(
            doc,
            lines,
            [{ start, end }],
            readMigrateMarkerMap(logger),
            cache,
            deps,
        );
        blockLines = converted.prepared.get(start) ?? blockLines;
        warnPassedThrough(converted.passedThrough);
    }

    const destLines = dedentBlock(blockLines, task.indent);
    const stub = buildMoveStub(task, deps.generateId(), deps.now());

    const target = await pickTarget(doc.uri);
    if (!target) return;

    const edit = new vscode.WorkspaceEdit();
    // Source: collapse the whole block to the single breadcrumb line.
    edit.replace(doc.uri, new vscode.Range(start, 0, end, doc.lineAt(end).text.length), stub);
    // Destination: create (if new) + append the de-indented block.
    await appendBlockToTarget(edit, target, destLines, eolOf(doc));

    if (!(await vscode.workspace.applyEdit(edit))) {
        void vscode.window.showWarningMessage('Tsk: the move could not be applied.');
        return;
    }

    await revealMovedTask(target.uri, destLines.length);
    logger.debug(
        `${COMMANDS.moveTaskToFile}: moved ${end - start + 1} line(s) to ${target.uri.fsPath}`,
    );
}

/** Ask which `.tsk` file to move into — an existing one, or a new file via save dialog. */
async function pickTarget(
    sourceUri: vscode.Uri,
): Promise<{ uri: vscode.Uri; isNew: boolean } | undefined> {
    const files = (await vscode.workspace.findFiles('**/*.tsk', '**/node_modules/**')).filter(
        (u) => u.toString() !== sourceUri.toString(),
    );
    const items: TargetItem[] = [
        { label: '$(new-file) New file…', newFile: true },
        ...files
            .map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri }))
            .sort((a, b) => a.label.localeCompare(b.label)),
    ];
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Move task to which .tsk file?',
    });
    if (!picked) return undefined;

    if (picked.newFile) {
        const dir = vscode.Uri.joinPath(sourceUri, '..');
        const saved = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(dir, 'tasks.tsk'),
            filters: { 'Tsk files': ['tsk'] },
            saveLabel: 'Move here',
        });
        if (!saved) return undefined;
        if (saved.toString() === sourceUri.toString()) {
            void vscode.window.showWarningMessage('Tsk: pick a file other than the source.');
            return undefined;
        }
        return { uri: saved, isNew: !(await uriExists(saved)) };
    }

    return picked.uri ? { uri: picked.uri, isNew: false } : undefined;
}

/** Add the relocated block to the destination (creating the file when new). */
async function appendBlockToTarget(
    edit: vscode.WorkspaceEdit,
    target: { uri: vscode.Uri; isNew: boolean },
    destLines: readonly string[],
    fallbackEol: string,
): Promise<void> {
    if (target.isNew) {
        // Create the file WITH its contents in one resource edit — NOT createFile +
        // a separate insert, which splits the bulk-edit undo so a single Ctrl+Z
        // restores the source but leaves the new file behind (a phantom duplicate
        // @id). With contents, the whole move undoes atomically.
        edit.createFile(target.uri, {
            ignoreIfExists: true,
            contents: Buffer.from(buildAppendText('', destLines, fallbackEol), 'utf8'),
        });
        return;
    }
    const targetDoc = await vscode.workspace.openTextDocument(target.uri);
    const endPos = targetDoc.lineAt(targetDoc.lineCount - 1).range.end;
    edit.insert(
        target.uri,
        endPos,
        buildAppendText(targetDoc.getText(), destLines, eolOf(targetDoc)),
    );
}

/** Open the destination and put the cursor on the relocated task (start of the appended block). */
async function revealMovedTask(uri: vscode.Uri, blockLineCount: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const targetEditor = await vscode.window.showTextDocument(doc);
    // The block is at the file's tail; the trailing EOL adds one empty line.
    const firstBlockLine = Math.max(
        0,
        Math.min(doc.lineCount - 1, doc.lineCount - blockLineCount - 1),
    );
    const pos = new vscode.Position(firstBlockLine, 0);
    targetEditor.selection = new vscode.Selection(pos, pos);
    targetEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

function eolOf(doc: vscode.TextDocument): string {
    return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

/** The active editor's tab width (block indentation is column-aware); 4 by default. */
function resolveTabSize(): number {
    const ts = vscode.window.activeTextEditor?.options.tabSize;
    return typeof ts === 'number' ? ts : 4;
}

// ── "Send to tsk file" — the migrate+move one-shot ──────────────────────────

/**
 * Register the send commands: `tsk.sendMarkdownTaskToFile` (one id-less md
 * task block: derive git stamps → convert the whole block, top included →
 * relocate, in ONE edit — the converted form never materializes in the md
 * file, just the `[>]` breadcrumb) and `tsk.sendAllMarkdownTasks` (every
 * top-level task block in the file/selection to one picked target — the md
 * evacuation command). Send on an id-carrying line delegates to the plain
 * move (same pipeline; the only difference is whether the top needs an id).
 */
export function registerSendMarkdownCommands(
    context: vscode.ExtensionContext,
    logger: Logger,
    cache: CacheService,
    deps: MoveDeps = defaultMoveDeps,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            COMMANDS.sendMarkdownTaskToFile,
            (uri?: vscode.Uri, line?: number) =>
                sendMarkdownTaskToFile(deps, cache, logger, uri, line),
        ),
        vscode.commands.registerCommand(COMMANDS.sendAllMarkdownTasks, (uri?: vscode.Uri) =>
            sendAllMarkdownTasks(deps, cache, logger, uri),
        ),
    );
}

interface BlockRange {
    start: number;
    end: number;
}

/**
 * Convert the id-less md-task lines of each block (shared by move-from-md and
 * both sends): ONE stamp-derivation pass across every block's candidates, ONE
 * guarded id factory for the whole run, then `prepareMdBlockForTsk` per
 * block. Returns the prepared lines keyed by block start.
 */
async function convertBlocks(
    doc: vscode.TextDocument,
    lines: readonly string[],
    blocks: readonly BlockRange[],
    map: ReadonlyMap<string, Marker>,
    cache: CacheService,
    deps: MoveDeps,
    token?: vscode.CancellationToken,
    onProgress?: (message: string) => void,
): Promise<{
    prepared: Map<number, readonly string[]>;
    fallbacks: number;
    passedThrough: number;
    cancelled: boolean;
}> {
    const candidates: number[] = [];
    for (const { start, end } of blocks) {
        for (let i = start; i <= end; i++) {
            const line = lines[i] as string;
            if (matchMdTask(line, map) && !extractMetadata(line).metadata.has('id')) {
                candidates.push(i);
            }
        }
    }
    const derived = await deriveStampsForDocLines(
        doc,
        lines,
        candidates,
        map,
        deps.now,
        token,
        onProgress,
    );
    if (derived.cancelled) {
        return { prepared: new Map(), fallbacks: 0, passedThrough: 0, cancelled: true };
    }

    const freshId = makeGuardedIdFactory(cache, deps.generateId);
    const prepared = new Map<number, readonly string[]>();
    let passedThrough = 0;
    for (const { start, end } of blocks) {
        const block = prepareMdBlockForTsk(
            lines.slice(start, end + 1),
            map,
            (i) => derived.stamps.get(start + i) as MdStamps,
            freshId,
        );
        prepared.set(start, block.lines);
        passedThrough += block.passedThrough.length;
    }
    return { prepared, fallbacks: derived.fallbacks, passedThrough, cancelled: false };
}

function warnPassedThrough(count: number): void {
    if (count === 0) return;
    // Worded prospectively — this fires before the target pick / applyEdit,
    // either of which the user can still cancel.
    void vscode.window.showWarningMessage(
        `Tsk: ${count} bracketed line(s) match neither the markdown marker map nor tsk — they move as-is.`,
    );
}

async function sendMarkdownTaskToFile(
    deps: MoveDeps,
    cache: CacheService,
    logger: Logger,
    uriArg?: vscode.Uri,
    lineArg?: number,
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const doc = uriArg ? await vscode.workspace.openTextDocument(uriArg) : editor?.document;
    if (!doc || doc.languageId !== MARKDOWN_LANGUAGE_ID) {
        void vscode.window.showInformationMessage('Tsk: open a Markdown file to send tasks from.');
        return;
    }
    const taskLine = lineArg ?? editor?.selection.active.line ?? 0;
    const lineText = doc.lineAt(taskLine).text;

    // An id-carrying line is already tsk — send degenerates to the plain move.
    if (parseLine(lineText)?.metadata.get('id')) {
        return moveTaskToFile(deps, cache, logger, doc.uri, taskLine);
    }
    const map = readMigrateMarkerMap(logger);
    if (!matchMdTask(lineText, map) || extractMetadata(lineText).metadata.has('id')) {
        void vscode.window.showInformationMessage('Tsk: not on a markdown task line.');
        return;
    }

    const lines = doc.getText().split(/\r?\n/);
    const block = computeTaskBlockRange(lines, taskLine, resolveTabSize());
    const converted = await convertBlocks(doc, lines, [block], map, cache, deps);
    const prepared = converted.prepared.get(block.start) as readonly string[];
    warnPassedThrough(converted.passedThrough);

    // The converted top now carries the fresh @id the breadcrumb points at.
    const top = parseLine(prepared[0] as string);
    if (!top?.metadata.get('id')) {
        void vscode.window.showWarningMessage('Tsk: could not convert the task for sending.');
        return;
    }
    const stub = buildMoveStub(top, deps.generateId(), deps.now());

    const target = await pickTarget(doc.uri);
    if (!target) return;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
        doc.uri,
        new vscode.Range(block.start, 0, block.end, doc.lineAt(block.end).text.length),
        stub,
    );
    const destLines = dedentBlock(prepared, top.indent);
    await appendBlockToTarget(edit, target, destLines, eolOf(doc));
    if (!(await vscode.workspace.applyEdit(edit))) {
        void vscode.window.showWarningMessage('Tsk: the send could not be applied.');
        return;
    }
    await revealMovedTask(target.uri, destLines.length);
    const parts = [`sent 1 task (${destLines.length} line${destLines.length === 1 ? '' : 's'})`];
    if (converted.fallbacks > 0) parts.push(`${converted.fallbacks} stamped now (no git history)`);
    void vscode.window.showInformationMessage(`Tsk: ${parts.join(' · ')}.`);
    logger.info(`${COMMANDS.sendMarkdownTaskToFile}: ${parts.join(', ')} → ${target.uri.fsPath}`);
}

async function sendAllMarkdownTasks(
    deps: MoveDeps,
    cache: CacheService,
    logger: Logger,
    uriArg?: vscode.Uri,
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const doc = uriArg ? await vscode.workspace.openTextDocument(uriArg) : editor?.document;
    if (!doc || doc.languageId !== MARKDOWN_LANGUAGE_ID) {
        void vscode.window.showInformationMessage('Tsk: open a Markdown file to send tasks from.');
        return;
    }

    const map = readMigrateMarkerMap(logger);
    const lines = doc.getText().split(/\r?\n/);
    const tabSize = resolveTabSize();

    // Top-level task blocks: every line (in EITHER vocabulary) not already
    // inside a previous block tops one; nested tasks travel inside it.
    const blocks: BlockRange[] = [];
    for (let i = 0; i < lines.length; ) {
        const line = lines[i] as string;
        if (matchMdTask(line, map) || parseLine(line)) {
            const block = computeTaskBlockRange(lines, i, tabSize);
            blocks.push(block);
            i = block.end + 1;
        } else {
            i++;
        }
    }
    // A selection touching ANY line of a block sends the whole block (a torn
    // block would corrupt structure).
    const selection =
        editor?.document === doc && !editor.selection.isEmpty ? editor.selection : undefined;
    const chosen = selection
        ? blocks.filter((b) => b.start <= selection.end.line && b.end >= selection.start.line)
        : blocks;
    if (chosen.length === 0) {
        void vscode.window.showInformationMessage('Tsk: no task blocks to send here.');
        return;
    }

    // Pick the one target FIRST — don't run a long derivation only to present
    // a dialog afterwards.
    const target = await pickTarget(doc.uri);
    if (!target) return;

    const converted = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Tsk: deriving task history from git…',
            cancellable: true,
        },
        (progress, token) =>
            convertBlocks(doc, lines, chosen, map, cache, deps, token, (message) =>
                progress.report({ message }),
            ),
    );
    if (converted.cancelled) {
        logger.info(`${COMMANDS.sendAllMarkdownTasks}: cancelled — nothing applied.`);
        return;
    }
    warnPassedThrough(converted.passedThrough);

    const edit = new vscode.WorkspaceEdit();
    const combined: string[] = [];
    let sent = 0;
    let skipped = 0;
    for (const block of chosen) {
        const prepared = converted.prepared.get(block.start) as readonly string[];
        const top = parseLine(prepared[0] as string);
        if (!top?.metadata.get('id')) {
            skipped++; // e.g. an id-less [!]-style line tsk parses but nothing converted
            continue;
        }
        edit.replace(
            doc.uri,
            new vscode.Range(block.start, 0, block.end, doc.lineAt(block.end).text.length),
            buildMoveStub(top, deps.generateId(), deps.now()),
        );
        if (combined.length > 0) combined.push('');
        combined.push(...dedentBlock(prepared, top.indent));
        sent++;
    }
    if (sent === 0) {
        void vscode.window.showInformationMessage('Tsk: nothing sendable here (no task ids).');
        return;
    }
    await appendBlockToTarget(edit, target, combined, eolOf(doc));
    if (!(await vscode.workspace.applyEdit(edit))) {
        void vscode.window.showWarningMessage('Tsk: the send could not be applied.');
        return;
    }
    await revealMovedTask(target.uri, combined.length);

    const parts = [`sent ${sent} task block${sent === 1 ? '' : 's'} (${combined.length} lines)`];
    if (converted.fallbacks > 0) parts.push(`${converted.fallbacks} stamped now (no git history)`);
    if (converted.passedThrough > 0) parts.push(`${converted.passedThrough} unconverted line(s)`);
    if (skipped > 0) parts.push(`${skipped} block(s) skipped (no id)`);
    void vscode.window.showInformationMessage(`Tsk: ${parts.join(' · ')}.`);
    logger.info(`${COMMANDS.sendAllMarkdownTasks}: ${parts.join(', ')} → ${target.uri.fsPath}`);
}
