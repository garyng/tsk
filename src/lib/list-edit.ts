import { parseLine } from './parser';
import type { ToggleDeps } from './toggle-mutators';

/**
 * Editor settings the pure helpers consult to compute indent/dedent steps.
 * Activation layer reads these from `editor.options`.
 */
export interface EditorOpts {
    insertSpaces: boolean;
    tabSize: number;
}

/**
 * Result shape returned by every list-edit helper. Activation layer
 * translates each kind into a `WorkspaceEdit` (+ cursor move).
 */
export type ListEditAction =
    | { kind: 'noop' }
    | { kind: 'replace-line'; text: string; cursorCol: number }
    | { kind: 'split-line'; firstText: string; secondText: string; cursorCol: number };

/**
 * Compute what Enter should do on the given task line.
 *
 * Behavior (MD-AIO-inspired, with tsk simplifications + metadata preservation):
 *
 *   - Cursor before the marker prefix (in the indent or on `- [X]` itself)
 *     → `noop` (default Enter inserts a newline at the cursor).
 *   - Empty task at indent → outdent the line by one indent level.
 *   - Empty task at column 0 → remove the whole task (line becomes empty).
 *     Drops the metadata too, since tsk has no UI for a metadata-only line.
 *   - Cursor inside the metadata block → `noop`. We don't try to be clever
 *     mid-metadata; the user can split if they really want.
 *   - Cursor at end of content (just before `<!--`) or at end of line
 *     → empty continuation: line 1 unchanged, line 2 is a fresh empty
 *     task at the same indent with new `@id` + `@created`.
 *   - Cursor mid-content → split:
 *       line 1 = `<prefix> <content-before-cursor> <original-metadata>`
 *               (metadata pinned to the original task per spec)
 *       line 2 = `<prefix-with-[ ]-marker> <content-after-cursor> <new-metadata>`
 *
 * Pure — no `vscode` import. Activation layer applies the edit + moves
 * the cursor.
 */
export function computeEnterEdit(
    line: string,
    cursorCol: number,
    opts: EditorOpts,
    deps: ToggleDeps,
): ListEditAction {
    const parsed = parseLine(line);
    if (!parsed) return { kind: 'noop' };

    const bracketStart = parsed.raw.indexOf('[', parsed.indent.length);
    if (bracketStart < 0) return { kind: 'noop' };
    const prefixEnd = bracketStart + 4;

    // Cursor in/before the marker prefix — default Enter.
    if (cursorCol < prefixEnd) return { kind: 'noop' };

    // Empty task: outdent or remove.
    if (parsed.content === '') {
        if (parsed.indent.length === 0) {
            return { kind: 'replace-line', text: '', cursorCol: 0 };
        }
        const dedented = dedentString(parsed.raw, opts);
        const removed = parsed.raw.length - dedented.length;
        return {
            kind: 'replace-line',
            text: dedented,
            cursorCol: Math.max(0, cursorCol - removed),
        };
    }

    // Non-empty task. Continuation path.
    const metadataStart = parsed.raw.indexOf('<!--', prefixEnd);

    // Cursor strictly *inside* the metadata block → default Enter.
    if (metadataStart >= 0 && cursorCol > metadataStart && cursorCol < parsed.raw.length) {
        return { kind: 'noop' };
    }

    const searchEnd = metadataStart >= 0 ? metadataStart : parsed.raw.length;
    let contentEnd = searchEnd;
    while (contentEnd > prefixEnd) {
        const ch = parsed.raw.charAt(contentEnd - 1);
        if (!/\s/.test(ch)) break;
        contentEnd--;
    }

    const continuationPrefix = `${parsed.indent}- [ ]`;
    const newMetadata = `<!-- @id:${deps.generateId()} @created:${deps.now()} -->`;

    if (cursorCol >= contentEnd) {
        // Empty continuation. Line 1 stays as-is; line 2 is fresh empty task.
        return {
            kind: 'split-line',
            firstText: parsed.raw,
            secondText: `${continuationPrefix} ${newMetadata}`,
            cursorCol: continuationPrefix.length + 1,
        };
    }

    // Mid-content split.
    const beforeContent = parsed.raw.slice(prefixEnd, cursorCol).trimEnd();
    const afterContent = parsed.raw.slice(cursorCol, contentEnd).trimStart();
    const originalMetadata = metadataStart >= 0 ? parsed.raw.slice(metadataStart) : '';

    const firstPrefix = parsed.raw.slice(0, prefixEnd).trimEnd();
    const firstParts: string[] = [firstPrefix];
    if (beforeContent !== '') firstParts.push(beforeContent);
    if (originalMetadata !== '') firstParts.push(originalMetadata);
    const firstText = firstParts.join(' ');

    const secondParts: string[] = [continuationPrefix];
    if (afterContent !== '') secondParts.push(afterContent);
    secondParts.push(newMetadata);
    const secondText = secondParts.join(' ');

    return {
        kind: 'split-line',
        firstText,
        secondText,
        cursorCol: continuationPrefix.length + 1,
    };
}

/**
 * Compute what Tab should do on the given task line.
 *
 * Per the simplified spec, Tab only intercepts on **empty tasks** (indent
 * the whole line by one level). Tab on a non-empty task — or anything
 * outside a task — returns `noop` and the activation layer falls back to
 * the editor's default Tab (usually inserts a tab/spaces or triggers
 * indent if a multi-line selection).
 */
export function computeTabEdit(line: string, cursorCol: number, opts: EditorOpts): ListEditAction {
    const parsed = parseLine(line);
    if (!parsed) return { kind: 'noop' };
    if (parsed.content !== '') return { kind: 'noop' };

    const indented = indentString(parsed.raw, opts);
    const added = indented.length - parsed.raw.length;
    return {
        kind: 'replace-line',
        text: indented,
        cursorCol: cursorCol + added,
    };
}

/**
 * Compute what Shift+Tab should do on the given task line.
 *
 * Shift+Tab on **any** task with indent outdents by one level. On a
 * column-0 task or non-task line, returns `noop`.
 */
export function computeShiftTabEdit(
    line: string,
    cursorCol: number,
    opts: EditorOpts,
): ListEditAction {
    const parsed = parseLine(line);
    if (!parsed) return { kind: 'noop' };
    if (parsed.indent.length === 0) return { kind: 'noop' };

    const dedented = dedentString(parsed.raw, opts);
    const removed = parsed.raw.length - dedented.length;
    return {
        kind: 'replace-line',
        text: dedented,
        cursorCol: Math.max(0, cursorCol - removed),
    };
}

/** Prepend one indent level (tabs honored when `insertSpaces` is false). */
function indentString(line: string, opts: EditorOpts): string {
    const oneLevel = opts.insertSpaces ? ' '.repeat(opts.tabSize) : '\t';
    return oneLevel + line;
}

/**
 * Remove one indent level from the start of `line`. If the indent begins
 * with a tab, removes exactly one tab; otherwise removes up to `tabSize`
 * leading spaces (clamped to the actual indent length so we never eat into
 * the bullet).
 */
function dedentString(line: string, opts: EditorOpts): string {
    const match = /^\s*/.exec(line);
    if (!match) return line;
    const indent = match[0];
    if (indent === '') return line;
    if (indent.startsWith('\t')) return line.slice(1);
    return line.slice(Math.min(opts.tabSize, indent.length));
}
