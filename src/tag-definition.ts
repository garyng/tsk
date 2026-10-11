import * as vscode from 'vscode';
import { COMMANDS, TSK_LANGUAGE_ID } from './constants';
import type { Logger } from './lib/logger';
import { findTagDeclarationLine, tagSpanAt } from './lib/tag-span';
import { buildTagEntryText } from './lib/tags-sync';
import type { TagsLoader } from './tags-loader';

/**
 * Ctrl+click a `#tag` to reach its `tags.yml` declaration, and a code action /
 * command to create that declaration with a description when it's missing.
 *
 * **Why a `DefinitionProvider` and not a `DocumentLink` with a `command:` URI.**
 * The obvious design is a command-URI link, which is the only way to put an
 * arbitrary action behind ctrl+click. But "go to where this is declared" is
 * exactly Go-to-Definition, which ctrl+click already *is* — so the native
 * mechanism needs no command URI, no trust question, and is directly testable
 * (`vscode.executeDefinitionProvider`). The prompt-for-a-description half, which
 * a definition provider cannot do, becomes a code action on the same line; an
 * undeclared tag therefore answers ctrl+click with VS Code's own "no definition
 * found", which is a truthful signal rather than silence.
 */
export function registerTagDefinition(
    context: vscode.ExtensionContext,
    loader: TagsLoader,
    logger: Logger,
): void {
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            { language: TSK_LANGUAGE_ID },
            { provideDefinition: (document, position) => provide(document, position, loader) },
        ),
        vscode.languages.registerCodeActionsProvider(
            { language: TSK_LANGUAGE_ID },
            { provideCodeActions: (document, range) => provideActions(document, range, loader) },
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
        ),
        vscode.commands.registerCommand(COMMANDS.defineTag, (tag?: string) =>
            defineTag(loader, logger, tag),
        ),
    );
}

/** The configured `tags.yml` as a Uri, or `undefined` when none is resolvable. */
function tagsUri(loader: TagsLoader): vscode.Uri | undefined {
    const path = loader.getPath();
    return path ? vscode.Uri.file(path) : undefined;
}

/** `tags.yml` as a document, or `undefined` when it can't be opened (e.g. doesn't exist yet). */
async function readTagsText(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    try {
        return await vscode.workspace.openTextDocument(uri);
    } catch {
        return undefined;
    }
}

async function provide(
    document: vscode.TextDocument,
    position: vscode.Position,
    loader: TagsLoader,
): Promise<vscode.Definition | undefined> {
    const span = tagSpanAt(document.lineAt(position.line).text, position.character);
    if (!span) return undefined;
    const uri = tagsUri(loader);
    if (!uri) return undefined;
    const doc = await readTagsText(uri);
    if (!doc) return undefined;
    const line = findTagDeclarationLine(doc.getText(), span.tag);
    if (line === null) return undefined;
    // Span the entry from its key to end of line (indentation excluded), so the
    // peek widget frames it.
    const text = doc.lineAt(line).text;
    const startCol = text.length - text.trimStart().length;
    return new vscode.Location(uri, new vscode.Range(line, startCol, line, text.length));
}

async function provideActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    loader: TagsLoader,
): Promise<vscode.CodeAction[] | undefined> {
    const span = tagSpanAt(document.lineAt(range.start.line).text, range.start.character);
    if (!span) return undefined;
    const uri = tagsUri(loader);
    if (!uri) return undefined;
    const doc = await readTagsText(uri);
    if (doc && findTagDeclarationLine(doc.getText(), span.tag) !== null) return undefined;

    const action = new vscode.CodeAction(
        `Define #${span.tag} in tags.yml…`,
        vscode.CodeActionKind.QuickFix,
    );
    action.command = {
        command: COMMANDS.defineTag,
        title: action.title,
        arguments: [span.tag],
    };
    return [action];
}

/**
 * Declare `tag` in `tags.yml` with a description, or reveal it if already
 * declared — the whole "ctrl+click a tag" intent in one command, reachable
 * from the palette and from the code action.
 */
async function defineTag(loader: TagsLoader, logger: Logger, tag?: string): Promise<void> {
    const resolved = tag ?? tagUnderCursor();
    if (!resolved) {
        void vscode.window.showInformationMessage('Tsk: put the cursor on a #tag first.');
        return;
    }
    const uri = tagsUri(loader);
    if (!uri) {
        void vscode.window.showInformationMessage(
            'Tsk: no tags.yml path is configured (open a workspace, or set tsk.tags.path).',
        );
        return;
    }

    const doc = await readTagsText(uri);
    const existingText = doc?.getText() ?? '';
    const declaredAt = findTagDeclarationLine(existingText, resolved);
    if (declaredAt !== null) {
        // Already declared — just reveal it.
        await vscode.window.showTextDocument(doc as vscode.TextDocument, {
            selection: new vscode.Range(declaredAt, 0, declaredAt, 0),
        });
        return;
    }

    const description = await vscode.window.showInputBox({
        prompt: `Description for #${resolved}`,
        placeHolder: 'what this tag is for',
    });
    if (description === undefined) {
        logger.debug(`${COMMANDS.defineTag}: cancelled`);
        return;
    }

    const eol = doc?.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const appendText = buildTagEntryText(existingText, resolved, description.trim(), eol);
    const edit = new vscode.WorkspaceEdit();
    if (doc) {
        edit.insert(uri, doc.lineAt(doc.lineCount - 1).range.end, appendText);
    } else {
        // createFile-with-contents → one atomic resource edit, undoes cleanly.
        edit.createFile(uri, { ignoreIfExists: true, contents: Buffer.from(appendText, 'utf8') });
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
        void vscode.window.showWarningMessage('Tsk: could not write tags.yml.');
        return;
    }
    await loader.reload();
    logger.info(`${COMMANDS.defineTag}: declared #${resolved} in ${uri.fsPath}`);
}

/** The tag under the active editor's cursor, for the palette entry point. */
function tagUnderCursor(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const position = editor.selection.active;
    return tagSpanAt(editor.document.lineAt(position.line).text, position.character)?.tag;
}
