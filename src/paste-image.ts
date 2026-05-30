import { existsSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative } from 'pathe';
import * as vscode from 'vscode';
import { PASTE_IMAGE_BASE_DIRECTORY_KEY } from './constants';
import type { Logger } from './lib/logger';
import {
    buildImageMarkdownSnippet,
    defaultImageFilename,
    ensureExtension,
    extensionForMime,
    SUPPORTED_IMAGE_MIMES,
    validateImagePath,
} from './lib/paste-image-logic';

/**
 * Kind of the paste edit we contribute: a Markdown link insertion. Built
 * once — `append` returns a fresh kind each call, and the metadata + the
 * edit must carry the *same* instance for VSCode's kind-filtering to match.
 */
const PASTE_IMAGE_EDIT_KIND = vscode.DocumentDropOrPasteEditKind.Empty.append('markdown', 'link');

/**
 * Directory on disk that relative image paths resolve against. For any
 * file-backed document — including a notebook *cell*, whose
 * `vscode-notebook-cell:` URI still resolves `fsPath` to the owning
 * `.ipynb`'s path — that's the document's parent directory. Untitled
 * buffers have no on-disk anchor, so the paste falls through untouched.
 */
function documentDirectory(document: vscode.TextDocument): string | undefined {
    if (document.isUntitled) return undefined;
    return dirname(document.uri.fsPath);
}

/**
 * The configured `tsk.pasteImage.baseDirectory`, prepended (under the
 * document's directory) to the selection-derived path. Throwaway `''`
 * fallback — the package.json default (`./images`) wins for this contributed
 * setting (one source of truth for the default). A blank value means "save
 * directly beside the document", which is also the sane degrade if the
 * manifest entry ever went missing.
 */
function configuredBaseDirectory(): string {
    return vscode.workspace.getConfiguration('tsk').get<string>(PASTE_IMAGE_BASE_DIRECTORY_KEY, '');
}

/** Resolve a relative-or-absolute image path against the document directory. */
function resolveTarget(docDir: string, relPath: string): string {
    return isAbsolute(relPath) ? relPath : join(docDir, relPath);
}

/**
 * Range covering the filename stem within a full relative path, so the
 * input box can pre-select just the name (e.g. the timestamp) for the user
 * to overtype without disturbing the directory or extension.
 */
function stemSelection(path: string, ext: string): [number, number] {
    const base = basename(path);
    return [path.length - base.length, path.length - (ext.length + 1)];
}

/**
 * Prompt for an image path, pre-filling `value` and pre-selecting its stem.
 * Returns the trimmed path, or `undefined` if the user cancelled (Escape).
 */
async function promptForPath(
    value: string,
    ext: string,
    prompt: string,
): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
        title: 'Paste image',
        prompt,
        value,
        valueSelection: stemSelection(value, ext),
        validateInput: (v) => (v.trim() === '' ? 'Enter a path.' : undefined),
    });
    return input === undefined ? undefined : input.trim();
}

/**
 * Build the `DocumentPasteEdit` for saving `bytes` at `relPath` (resolved
 * against `docDir`, the document's directory). Factored out of the provider
 * so the e2e can drive it with raw bytes + a chosen path: a hand-built
 * `DataTransferItem` returns `undefined` from `asFile()`, so a real image
 * paste can't be replayed through `provideDocumentPasteEdits`.
 *
 * The file is *not* written here directly. Instead its creation rides on the
 * edit's `additionalEdit` (`WorkspaceEdit.createFile`), so VSCode applies the
 * inserted Markdown and the file write as one atomic, undoable step: Ctrl+Z
 * removes the text *and* deletes the saved image. `createFile` also makes any
 * intermediate directories, and `overwrite: true` lets the caller's
 * overwrite-anyway decision stick.
 *
 * Overwrite-undo caveat: VSCode replays an undo's file operations in their
 * collection order (each op inverted, but the list is NOT reordered — see
 * `bulkFileEdits.ts._reverse()`). So the `deleteFile`+`createFile` "snapshot
 * the original for restore" trick throws on undo: it re-creates the snapshot
 * (a create with no overwrite flag) before deleting the new file, hitting
 * "already exists". A single `createFile(overwrite)` undoes cleanly to a
 * delete — so undoing a paste that *overwrote* an existing image removes the
 * file rather than restoring the original; undo of a paste that created a
 * *new* file removes it as expected. Restoring an overwritten original isn't
 * reliably expressible through the `WorkspaceEdit` API today — that's the
 * open upstream bug microsoft/vscode#182573 ("createFile with overwrite
 * deletes file completely on undo"); re-check it if a fix lands.
 */
export function buildPastedImageEdit(
    docDir: string,
    relPath: string,
    bytes: Uint8Array,
    logger: Logger,
): vscode.DocumentPasteEdit {
    const target = resolveTarget(docDir, relPath);

    // pathe keeps everything forward-slashed; `relative` never yields a
    // leading `./`, so add one for in-tree paths (a `../` path is already a
    // valid Markdown destination and is left as-is).
    const rel = relative(docDir, target);
    const mdPath = rel.startsWith('.') ? rel : `./${rel}`;
    const altText = basename(target, extname(target));

    const fileEdit = new vscode.WorkspaceEdit();
    fileEdit.createFile(vscode.Uri.file(target), { contents: bytes, overwrite: true });

    const edit = new vscode.DocumentPasteEdit(
        new vscode.SnippetString(buildImageMarkdownSnippet(altText, mdPath)),
        'Save image and insert Markdown link',
        PASTE_IMAGE_EDIT_KIND,
    );
    edit.additionalEdit = fileEdit;
    logger.info(`paste-image: prepared ${target}`);
    return edit;
}

/**
 * Register the paste-image `DocumentPasteEditProvider` for `tsk` and
 * `markdown` documents (the latter also covers Jupyter markdown cells,
 * whose cell language id is `markdown`). On paste of an image MIME we save
 * the bytes and insert a relative Markdown image link; non-image pastes get
 * no edit and fall through. The inserted alt text is a snippet placeholder,
 * so it lands selected and ready to overtype.
 *
 * Path choice — the saved file is
 * `<document dir>/<tsk.pasteImage.baseDirectory>/<selection>.<ext>`:
 * - With a selection at the paste point, the selection is used *verbatim* as
 *   the path under the base directory (it may itself contain subdirectories;
 *   only the image extension is forced on). An unusable selection (empty,
 *   illegal char) raises a warning and the paste falls through.
 * - With no selection, an input box prompts for the path, pre-filled with
 *   `<baseDirectory>/<timestamp>.<ext>` and the stem pre-selected.
 *
 * Conflicts: if the target already exists, we re-prompt for a different
 * path; if the chosen path *still* exists, we warn and overwrite anyway.
 */
export function registerPasteImageProvider(context: vscode.ExtensionContext, logger: Logger): void {
    const provider: vscode.DocumentPasteEditProvider = {
        async provideDocumentPasteEdits(document, ranges, dataTransfer, _context, token) {
            let mime: string | undefined;
            let item: vscode.DataTransferItem | undefined;
            for (const candidate of SUPPORTED_IMAGE_MIMES) {
                const found = dataTransfer.get(candidate);
                if (found) {
                    mime = candidate;
                    item = found;
                    break;
                }
            }
            if (!mime || !item) return undefined;
            const ext = extensionForMime(mime);
            if (!ext) return undefined;

            const file = item.asFile();
            if (!file) return undefined;
            const bytes = await file.data();
            if (token.isCancellationRequested) return undefined;

            const docDir = documentDirectory(document);
            if (!docDir) {
                logger.debug(
                    `paste-image: cannot anchor ${document.uri.toString()}; passing through`,
                );
                return undefined;
            }

            const baseDirectory = configuredBaseDirectory();
            const selection = ranges.length > 0 ? document.getText(ranges[0]).trim() : '';

            let relPath: string;
            if (selection) {
                const problem = validateImagePath(selection);
                if (problem) {
                    void vscode.window.showWarningMessage(
                        `Tsk: can't use the selection as an image path — ${problem}.`,
                    );
                    return undefined;
                }
                relPath = join(baseDirectory, ensureExtension(selection, ext));
            } else {
                const fallback = join(baseDirectory, defaultImageFilename(new Date(), ext));
                const input = await promptForPath(
                    fallback,
                    ext,
                    'Where to save the image — relative to the current file, or an absolute path.',
                );
                if (input === undefined) {
                    logger.debug('paste-image: cancelled at path prompt');
                    return undefined;
                }
                relPath = input;
            }

            // Conflict: offer a rename; if the chosen path is still taken,
            // warn and overwrite anyway.
            if (existsSync(resolveTarget(docDir, relPath))) {
                const renamed = await promptForPath(
                    relPath,
                    ext,
                    `${relPath} already exists. Choose a different path, or confirm to overwrite.`,
                );
                if (renamed === undefined) {
                    logger.debug('paste-image: cancelled at conflict prompt');
                    return undefined;
                }
                relPath = renamed;
                if (existsSync(resolveTarget(docDir, relPath))) {
                    void vscode.window.showWarningMessage(
                        `Tsk: ${relPath} already exists — overwriting.`,
                    );
                }
            }

            return [buildPastedImageEdit(docDir, relPath, bytes, logger)];
        },
    };

    context.subscriptions.push(
        vscode.languages.registerDocumentPasteEditProvider(
            [{ language: 'tsk' }, { language: 'markdown' }],
            provider,
            {
                providedPasteEditKinds: [PASTE_IMAGE_EDIT_KIND],
                pasteMimeTypes: SUPPORTED_IMAGE_MIMES,
            },
        ),
    );
}
