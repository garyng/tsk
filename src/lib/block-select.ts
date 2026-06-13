/**
 * Pure decision logic for the "double-click → select the whole task block"
 * gesture. VSCode has no double-click event and no API to extend the editor's
 * built-in gestures, so the glue (`block-commands.ts`) watches mouse
 * selection-changes and asks this predicate whether the mouse landed on the
 * task's *structural prefix* (indent + bullet + `[marker]`) — the "handle" —
 * versus its content. Only a prefix hit expands to the block; a content hit is
 * left as VSCode's normal double-click-selects-a-word.
 *
 * The block *range* itself is `computeTaskBlockRange` in `move-task-logic.ts`
 * (shared with Move/Extract); this module owns only the prefix/content call.
 */

/**
 * Does a mouse selection target the task line's structural prefix (so it should
 * expand to the block) rather than its content (leave the word-select alone)?
 *
 * True iff the selection is **single-line**, **non-empty**, and **ends at or
 * before `contentStartChar`** — the column where the task's content begins
 * (`taskContentRange(line).start`, just past `- [m] `). Double-clicking the
 * indent selects a whitespace run; double-clicking the `[` of a marker selects
 * the bracket interior (tsk declares `[ ]` as a bracket pair) — both land wholly
 * inside `[0, contentStartChar)`. Double-clicking a content word starts at/after
 * `contentStartChar`, so it ends past it → false.
 *
 * The single-line guard rejects multi-line mouse drags (not a double-click); the
 * non-empty guard rejects a plain click (empty selection). Pure — the caller
 * supplies the selection coordinates and `contentStartChar`, and only calls this
 * for a `kind === Mouse` change on a parsed task line.
 */
export function mouseSelectionInPrefix(
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
    contentStartChar: number,
): boolean {
    if (startLine !== endLine) return false; // a multi-line drag, not a word double-click
    if (startChar === endChar) return false; // an empty selection (a plain click)
    return endChar <= contentStartChar; // ends within the prefix → the block "handle"
}
