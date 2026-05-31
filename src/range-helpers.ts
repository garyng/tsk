import * as vscode from 'vscode';

/**
 * Return a zero-width `vscode.Range` at column 0 of `line`. Useful as
 * an anchor for entities that conceptually live "on a line" rather than
 * over a span:
 *
 *   - **CodeLens** — VSCode renders the lens above the line containing
 *     the range's start; column doesn't matter.
 *   - **`setDecorations` with `isWholeLine: true`** — the decoration
 *     type widens the range to the whole line; we just need to name the
 *     row.
 *   - **`revealRange`** when scrolling to a specific row — the editor
 *     re-positions on the start of the range.
 *
 * Centralised so the `(line, 0, line, 0)` literal lives in one place
 * and the call sites read as an intention.
 */
export function pointRange(line: number): vscode.Range {
    return new vscode.Range(line, 0, line, 0);
}

/**
 * Replace the entire text of `lineNumber` with `next` on `edit`. The range
 * spans column 0 to `lineText.length`, so the whole row (minus its trailing
 * newline) is swapped in one operation. Centralises the
 * `new vscode.Range(line, 0, line, lineText.length)` idiom shared by every
 * whole-line task mutation (toggle, duplicate-id refresh, the broken-ref and
 * add-id quick-fixes), keeping the off-by-one-prone column math in one place.
 */
export function replaceLine(
    edit: vscode.WorkspaceEdit,
    uri: vscode.Uri,
    lineNumber: number,
    lineText: string,
    next: string,
): void {
    edit.replace(uri, new vscode.Range(lineNumber, 0, lineNumber, lineText.length), next);
}
