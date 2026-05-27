import * as vscode from 'vscode';

const HIGHLIGHT_COLOR_ID = 'tsk.navigation.highlight';

interface CurrentHighlight {
    editor: vscode.TextEditor;
    line: number;
}

/**
 * Owns the whole-line decoration that lands on the target after a
 * `tsk.goTo*` navigate command. The decoration persists until either
 *
 *   - another navigate calls `set(…)` (which clears the prior one before
 *     applying the new one — at most one highlight is ever active),
 *   - the user moves the cursor with a keyboard / mouse action in the
 *     highlighted editor,
 *   - the active editor moves *off* the highlighted one (tab switch,
 *     editor close).
 *
 * Programmatic selection changes are deliberately ignored — the navigate
 * command itself sets `editor.selection`, which fires a
 * `TextEditorSelectionChangeKind.Command` event we must filter out, or
 * the highlight would be cleared milliseconds after we apply it.
 *
 * The class registers its own listeners in the constructor and tears
 * them down in `dispose()`; activation just adds it to
 * `context.subscriptions`.
 */
export class NavigationHighlight implements vscode.Disposable {
    private readonly decorationType: vscode.TextEditorDecorationType;
    private current: CurrentHighlight | undefined;
    private readonly subscriptions: vscode.Disposable[] = [];

    constructor() {
        this.decorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor(HIGHLIGHT_COLOR_ID),
            isWholeLine: true,
        });
        this.subscriptions.push(
            vscode.window.onDidChangeTextEditorSelection((e) => this.onSelectionChange(e)),
            vscode.window.onDidChangeActiveTextEditor((editor) =>
                this.onActiveEditorChange(editor),
            ),
        );
    }

    /**
     * Replace the current highlight with one on `line` of `editor`.
     * Calling repeatedly is the natural way to navigate around — each
     * call cancels the prior decoration so the visual story stays
     * focused on the latest jump.
     */
    set(editor: vscode.TextEditor, line: number): void {
        this.clear();
        editor.setDecorations(this.decorationType, [new vscode.Range(line, 0, line, 0)]);
        this.current = { editor, line };
    }

    /** Explicit clear. Safe to call when no highlight is active. */
    clear(): void {
        if (!this.current) return;
        this.current.editor.setDecorations(this.decorationType, []);
        this.current = undefined;
    }

    /**
     * Snapshot of the active highlight — exposed via `TskExtensionApi`
     * so e2e tests can assert state without scraping the decoration
     * collection (which VSCode doesn't expose). Returns `undefined` when
     * no highlight is currently rendered.
     */
    getCurrent(): { uri: string; line: number } | undefined {
        if (!this.current) return undefined;
        return {
            uri: this.current.editor.document.uri.toString(),
            line: this.current.line,
        };
    }

    private onSelectionChange(e: vscode.TextEditorSelectionChangeEvent): void {
        if (!this.current) return;
        if (e.textEditor !== this.current.editor) return;
        // Filter: keep the highlight alive through programmatic and
        // unknown-cause selection changes. Only Keyboard / Mouse kinds
        // count as "the user moved the cursor."
        if (e.kind === undefined) return;
        if (e.kind === vscode.TextEditorSelectionChangeKind.Command) return;
        this.clear();
    }

    private onActiveEditorChange(editor: vscode.TextEditor | undefined): void {
        if (!this.current) return;
        if (editor === this.current.editor) return;
        this.clear();
    }

    dispose(): void {
        this.clear();
        this.decorationType.dispose();
        for (const sub of this.subscriptions) sub.dispose();
    }
}
