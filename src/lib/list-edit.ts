import { parseBullet, parseLine } from './parser';
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
    if (!parsed) return computeBulletEnter(line, cursorCol, opts);

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
        // Empty continuation. Line 1 stays as-is; line 2 is a fresh empty
        // task with **two** spaces between the marker and the metadata
        // (matches `wrapAsTask`'s empty-content shape). cursorCol lands
        // between the two spaces so the next keystroke is well-spaced.
        return {
            kind: 'split-line',
            firstText: parsed.raw,
            secondText: `${continuationPrefix}  ${newMetadata}`,
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
 * Enter handling for a *bare bullet* — a `-`/`*`/`+` list item without a `[ ]`
 * marker. Mirrors the task Enter behavior, minus any metadata:
 *
 *   - Cursor before the content → `noop` (default Enter).
 *   - Empty bullet → outdent one level (indented) or clear the line (column 0).
 *   - Cursor at/after the content end → empty continuation: a fresh `<bullet> `
 *     on the next line, preserving the original marker char (`*` stays `*`).
 *   - Mid-content → split into two bullets at the cursor.
 *
 * Returns `noop` for any non-bullet line. Pure — the activation layer applies
 * the edit + moves the cursor, exactly as for the task path.
 */
function computeBulletEnter(line: string, cursorCol: number, opts: EditorOpts): ListEditAction {
    const bullet = parseBullet(line);
    if (!bullet) return { kind: 'noop' };

    const prefixEnd = bullet.contentStart;
    // Cursor in/before the marker prefix — default Enter.
    if (cursorCol < prefixEnd) return { kind: 'noop' };

    // Empty bullet: outdent or remove (mirrors the empty-task path).
    if (bullet.content === '') {
        if (bullet.indent.length === 0) {
            return { kind: 'replace-line', text: '', cursorCol: 0 };
        }
        return dedentLineAction(bullet.raw, cursorCol, opts);
    }

    // The continuation marker normalises to a single space and reuses the same
    // bullet char, so `* a` continues as `* ` and `-   a` as `- `.
    const continuationPrefix = `${bullet.indent}${bullet.bullet} `;
    const contentEnd = prefixEnd + bullet.content.length;

    if (cursorCol >= contentEnd) {
        // Empty continuation: a fresh empty bullet below.
        return {
            kind: 'split-line',
            firstText: bullet.raw,
            secondText: continuationPrefix,
            cursorCol: continuationPrefix.length,
        };
    }

    // Mid-content split into two bullets. An empty `before` collapses to the
    // continuation prefix (`- `), which is a valid empty bullet.
    const before = bullet.raw.slice(prefixEnd, cursorCol).trimEnd();
    const after = bullet.raw.slice(cursorCol, contentEnd).trimStart();
    return {
        kind: 'split-line',
        firstText: `${bullet.indent}${bullet.bullet} ${before}`,
        secondText: `${continuationPrefix}${after}`,
        cursorCol: continuationPrefix.length,
    };
}

/**
 * Compute what Backspace should do on the given line — the Markdown-All-in-One
 * "degrade" ladder for empty list items:
 *
 *   - Empty **task** (`- [m]··<!-- … -->`), cursor in the (empty) content area
 *     → bare bullet `<indent>- `: the `[m]` marker **and all metadata** are
 *     dropped. Cursor lands just after the `- `.
 *   - Empty **bare bullet** (`<indent>- `), cursor at/after the marker → strip
 *     the `- `, leaving just the indent. Cursor lands at the indent end (a
 *     follow-up Backspace then eats the indent via the editor default).
 *   - Anything else (non-empty item, cursor inside the marker or metadata, or a
 *     non-list line) → `noop`, so the editor's default Backspace applies.
 *
 * So Backspace walks `task → bullet → (indent →) empty`, the inverse of `toggleTodo`'s
 * `bullet → task`. Pure — no `vscode` import.
 */
export function computeBackspaceEdit(line: string, cursorCol: number): ListEditAction {
    const parsed = parseLine(line);
    if (parsed) {
        if (parsed.content !== '') return { kind: 'noop' };
        const bracketEnd = parsed.raw.indexOf(']', parsed.indent.length);
        // Cursor in/before the marker → let the default Backspace edit it.
        if (bracketEnd < 0 || cursorCol <= bracketEnd) return { kind: 'noop' };
        // Cursor inside the metadata block → default Backspace.
        const metadataStart = parsed.raw.indexOf('<!--', bracketEnd);
        if (metadataStart >= 0 && cursorCol > metadataStart) return { kind: 'noop' };
        return {
            kind: 'replace-line',
            text: `${parsed.indent}- `,
            cursorCol: parsed.indent.length + 2,
        };
    }
    const bullet = parseBullet(line);
    if (bullet) {
        // Only an empty bullet degrades, and only from the content position
        // (cursor before the marker → default Backspace nibbles the marker).
        if (bullet.content !== '' || cursorCol < bullet.contentStart) return { kind: 'noop' };
        return { kind: 'replace-line', text: bullet.indent, cursorCol: bullet.indent.length };
    }
    return { kind: 'noop' };
}

/**
 * Compute what Tab should do on the given line.
 *
 * Per the simplified spec, Tab only intercepts on **empty** task/bullet lines
 * (indent the whole line by one level). Tab on a non-empty task or bullet — or
 * anything that isn't a list line — returns `noop` and the activation layer
 * falls back to the editor's default Tab. Bare bullets follow the same
 * empty-only rule as tasks: a deliberate tsk-consistency choice over MAIO's
 * "indent any list item".
 */
export function computeTabEdit(line: string, cursorCol: number, opts: EditorOpts): ListEditAction {
    const parsed = parseLine(line);
    if (parsed) {
        return parsed.content === ''
            ? indentLineAction(parsed.raw, cursorCol, opts)
            : { kind: 'noop' };
    }
    const bullet = parseBullet(line);
    if (bullet) {
        return bullet.content === ''
            ? indentLineAction(bullet.raw, cursorCol, opts)
            : { kind: 'noop' };
    }
    return { kind: 'noop' };
}

/**
 * Compute what Shift+Tab should do on the given line.
 *
 * Shift+Tab on **any** indented task or bare bullet outdents by one level. On a
 * column-0 line (no indent) or a non-list line, returns `noop`.
 */
export function computeShiftTabEdit(
    line: string,
    cursorCol: number,
    opts: EditorOpts,
): ListEditAction {
    const parsed = parseLine(line);
    if (parsed) {
        return parsed.indent.length === 0
            ? { kind: 'noop' }
            : dedentLineAction(parsed.raw, cursorCol, opts);
    }
    const bullet = parseBullet(line);
    if (bullet) {
        return bullet.indent.length === 0
            ? { kind: 'noop' }
            : dedentLineAction(bullet.raw, cursorCol, opts);
    }
    return { kind: 'noop' };
}

/** Indent `raw` one level and shift the cursor right by the added width. */
function indentLineAction(raw: string, cursorCol: number, opts: EditorOpts): ListEditAction {
    const indented = indentString(raw, opts);
    const added = indented.length - raw.length;
    return { kind: 'replace-line', text: indented, cursorCol: cursorCol + added };
}

/** Outdent `raw` one level and shift the cursor left by the removed width. */
function dedentLineAction(raw: string, cursorCol: number, opts: EditorOpts): ListEditAction {
    const dedented = dedentString(raw, opts);
    const removed = raw.length - dedented.length;
    return { kind: 'replace-line', text: dedented, cursorCol: Math.max(0, cursorCol - removed) };
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
