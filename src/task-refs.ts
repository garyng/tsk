import * as vscode from 'vscode';
import { COMMANDS, TSK_LANGUAGE_ID } from './constants';
import type { CacheService } from './lib/cache';
import { cancelDebounced, scheduleDebounced } from './lib/debounce';
import type { Logger } from './lib/logger';
import { GLYPH, MARKERS, type Marker } from './lib/markers';
import { shownRefs } from './lib/tsk-ref';

/**
 * `tsk:<id>` in Markdown and `.tsk` files: each ref a link to `tsk.revealTask`,
 * with the task's marker drawn after it — `[x]` in the marker's colour, as a
 * `.tsk` file shows it, or a muted `[?]` for an id no `.tsk` file has. The
 * marker is the live part: it's redrawn after every rescan, so a `tsk done` in
 * a terminal shows in the open plan. A link's tooltip is the task's text when
 * the links were last asked for.
 */

const REF_LANGUAGES = ['markdown', TSK_LANGUAGE_ID];
const SELECTOR: vscode.DocumentSelector = REF_LANGUAGES.map((language) => ({ language }));
const UNKNOWN_COLOR_ID = 'disabledForeground';
const EDIT_DEBOUNCE_MS = 150;

/** Where a marker was drawn, for e2e: VS Code can't be asked for an editor's decorations. */
export interface TaskRefMark {
    readonly line: number;
    /** Where the marker sits: right after the `tsk:<id>` token. */
    readonly character: number;
    readonly id: string;
    readonly marker: Marker | undefined;
}

export interface TaskRefs {
    /** Redraw the markers in every visible Markdown and `.tsk` editor. */
    reapply(): void;
    getMarks(uri: string): readonly TaskRefMark[] | undefined;
}

const isRefDocument = (doc: vscode.TextDocument) => REF_LANGUAGES.includes(doc.languageId);

/** `[ ]` keeps its width: a plain space at the edge of injected text can collapse. */
const shownGlyph = (marker: Marker) => `[${GLYPH[marker] === ' ' ? ' ' : GLYPH[marker]}]`;

function revealUri(id: string): vscode.Uri {
    return vscode.Uri.parse(
        `command:${COMMANDS.revealTask}?${encodeURIComponent(JSON.stringify([id]))}`,
    );
}

export function registerTaskRefs(
    context: vscode.ExtensionContext,
    cache: CacheService,
    logger: Logger,
): TaskRefs {
    const markerOf = (id: string) => cache.lookupById(id)?.marker;
    const after = (contentText: string, colorId: string): vscode.DecorationRenderOptions => ({
        after: { contentText, color: new vscode.ThemeColor(colorId), margin: '0 0 0 0.3ch' },
    });
    const markerTypes = new Map<Marker, vscode.TextEditorDecorationType>(
        MARKERS.map((def) => [
            def.name,
            vscode.window.createTextEditorDecorationType(
                after(shownGlyph(def.name), def.color?.id ?? 'editor.foreground'),
            ),
        ]),
    );
    const unknownType = vscode.window.createTextEditorDecorationType(
        after('[?]', UNKNOWN_COLOR_ID),
    );
    const marks = new Map<string, readonly TaskRefMark[]>();
    const timers = new Map<string, NodeJS.Timeout>();

    function provideLinks(doc: vscode.TextDocument): vscode.DocumentLink[] {
        const links: vscode.DocumentLink[] = [];
        for (let line = 0; line < doc.lineCount; line++) {
            for (const ref of shownRefs(doc.lineAt(line).text, markerOf)) {
                const link = new vscode.DocumentLink(
                    new vscode.Range(line, ref.start, line, ref.end),
                    revealUri(ref.id),
                );
                link.tooltip =
                    ref.marker === undefined
                        ? `No task tsk:${ref.id} in the workspace`
                        : (cache.lookupById(ref.id)?.content ?? `tsk:${ref.id}`);
                links.push(link);
            }
        }
        return links;
    }

    function apply(editor: vscode.TextEditor): void {
        const doc = editor.document;
        if (!isRefDocument(doc)) return;
        const found: TaskRefMark[] = [];
        for (let line = 0; line < doc.lineCount; line++) {
            for (const ref of shownRefs(doc.lineAt(line).text, markerOf))
                found.push({ line, character: ref.end, id: ref.id, marker: ref.marker });
        }
        const at = (m: TaskRefMark) => new vscode.Range(m.line, m.character, m.line, m.character);
        for (const [marker, type] of markerTypes)
            editor.setDecorations(type, found.filter((m) => m.marker === marker).map(at));
        editor.setDecorations(unknownType, found.filter((m) => m.marker === undefined).map(at));
        marks.set(doc.uri.toString(), found);
    }

    function reapply(): void {
        for (const editor of vscode.window.visibleTextEditors) apply(editor);
    }

    context.subscriptions.push(
        ...markerTypes.values(),
        unknownType,
        vscode.languages.registerDocumentLinkProvider(SELECTOR, {
            provideDocumentLinks: provideLinks,
        }),
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            for (const editor of editors) apply(editor);
        }),
        vscode.workspace.onDidChangeTextDocument(({ document }) => {
            if (!isRefDocument(document)) return;
            scheduleDebounced(timers, document.uri.toString(), EDIT_DEBOUNCE_MS, () => {
                for (const editor of vscode.window.visibleTextEditors)
                    if (editor.document === document) apply(editor);
            });
        }),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            cancelDebounced(timers, doc.uri.toString());
            marks.delete(doc.uri.toString());
        }),
    );
    reapply();
    logger.info('tsk:<id> links and markers registered for Markdown and .tsk files.');
    return { reapply, getMarks: (uri) => marks.get(uri) };
}
