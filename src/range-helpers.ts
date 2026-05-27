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
