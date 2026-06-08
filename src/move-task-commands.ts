import * as vscode from 'vscode';
import { COMMANDS, TSK_LANGUAGE_ID } from './constants';
import { isTskDocument } from './editor-guards';
import { generateId } from './lib/ids';
import type { Logger } from './lib/logger';
import {
    buildAppendText,
    buildMoveStub,
    computeTaskBlockRange,
    dedentBlock,
} from './lib/move-task-logic';
import { parseLine } from './lib/parser';
import { localTimestamp } from './lib/time';

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
    deps: MoveDeps = defaultMoveDeps,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            COMMANDS.moveTaskToFile,
            (uri?: vscode.Uri, line?: number) => moveTaskToFile(deps, logger, uri, line),
        ),
        vscode.languages.registerCodeActionsProvider(
            { language: TSK_LANGUAGE_ID },
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
    } else if (editor && isTskDocument(editor.document)) {
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
    const destLines = dedentBlock(lines.slice(start, end + 1), task.indent);
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
        edit.createFile(target.uri, { ignoreIfExists: true });
        edit.insert(
            target.uri,
            new vscode.Position(0, 0),
            buildAppendText('', destLines, fallbackEol),
        );
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
