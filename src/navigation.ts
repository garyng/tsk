import * as vscode from 'vscode';
import type { NavigationHighlight } from './navigation-highlight';
import { pointRange } from './range-helpers';

/**
 * Shared editor-navigation primitives behind the codelens go-to commands
 * (`navigate`) and the now-tree jump. Both resolve an `@id` to a `(file, line)`
 * by DIFFERENT means — codelens via `graph.getNode`, now-jump via
 * `resolveNowTarget` — so resolution stays at the call site; these take the
 * already-resolved coordinates and own the identical open → reveal → highlight
 * tail (and the peek widget), which used to be copy-pasted in both places.
 */

/** A resolved navigation target: which document + the zero-based line to land on. */
export interface NavTarget {
    readonly uri: vscode.Uri;
    readonly line: number;
}

export interface NavigateOptions {
    /** Paint the persistent navigation highlight on the landed line. */
    highlight?: NavigationHighlight;
    /** Preferred editor group (e.g. the panel's source column). */
    viewColumn?: vscode.ViewColumn;
    /**
     * Reuse the group already showing the target doc before falling back to
     * `viewColumn` — the markdown-preview-source model the now-jump wants so it
     * never spawns a stray tab over the webview panel.
     */
    reuseVisible?: boolean;
    preserveFocus?: boolean;
    preview?: boolean;
}

/** The "@id not found in the workspace" toast text — one source so both call sites match. */
export function targetNotFoundMessage(id: string): string {
    return `Tsk: task @id "${id}" not found in the workspace.`;
}

/**
 * Open `target.uri`, select + center `target.line`, and optionally paint the
 * navigation highlight. Returns the editor. Read-only (never edits). Options not
 * supplied are left to VS Code's defaults, so the codelens call (no options)
 * keeps its preview-tab/active-column behavior while the now-jump opts into
 * column-aware reuse + a permanent tab.
 */
export async function navigateTo(
    target: NavTarget,
    options: NavigateOptions = {},
): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument(target.uri);
    const range = pointRange(target.line);
    const reused = options.reuseVisible
        ? vscode.window.visibleTextEditors.find(
              (e) => e.document.uri.toString() === doc.uri.toString(),
          )
        : undefined;
    const viewColumn = reused?.viewColumn ?? options.viewColumn;
    const show: vscode.TextDocumentShowOptions = { selection: range };
    if (viewColumn !== undefined) show.viewColumn = viewColumn;
    if (options.preserveFocus !== undefined) show.preserveFocus = options.preserveFocus;
    if (options.preview !== undefined) show.preview = options.preview;
    const editor = await vscode.window.showTextDocument(doc, show);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    options.highlight?.set(editor, target.line);
    return editor;
}

/**
 * Open a peek widget anchored at `(sourceUri, sourceLine)` listing `targets`.
 * The caller passes already-resolved targets; returns `false` (without opening
 * anything) when the list is empty, so the caller can surface its own "nothing
 * to peek" message.
 */
export async function peekTargets(
    sourceUri: vscode.Uri,
    sourceLine: number,
    targets: readonly NavTarget[],
): Promise<boolean> {
    if (targets.length === 0) return false;
    const locations = targets.map(
        (t) => new vscode.Location(t.uri, new vscode.Position(t.line, 0)),
    );
    await vscode.commands.executeCommand(
        'editor.action.peekLocations',
        sourceUri,
        new vscode.Position(sourceLine, 0),
        locations,
        'peek',
    );
    return true;
}
