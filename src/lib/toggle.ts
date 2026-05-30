import { MARKERS, type Marker } from './markers';
import { replaceMetadata } from './metadata';
import { parseBullet, parseLine } from './parser';

/**
 * Marker → canonical write-back symbol (the first entry in `symbols`).
 * The parser also accepts uppercase aliases (`'X'`, `'N'`) on read but
 * toggle commands always emit the lowercase canonical form.
 */
const CANONICAL_SYMBOL: Record<Marker, string> = Object.fromEntries(
    MARKERS.map((m) => [m.name, m.symbols[0]]),
) as Record<Marker, string>;

/**
 * Replace the marker character on a task line in place. Indent, bullet,
 * content, and metadata are preserved byte-for-byte. Non-task lines pass
 * through unchanged.
 */
export function swapMarker(line: string, marker: Marker): string {
    const parsed = parseLine(line);
    if (!parsed) return line;
    const bracketStart = parsed.raw.indexOf('[', parsed.indent.length);
    if (bracketStart < 0) return line;
    return (
        parsed.raw.slice(0, bracketStart + 1) +
        CANONICAL_SYMBOL[marker] +
        parsed.raw.slice(bracketStart + 2)
    );
}

export interface WrapOpts {
    /** `@id` value — generated upstream via `generateId()`. */
    id: string;
    /** ISO local timestamp for `@created` — generated upstream via `localTimestamp()`. */
    timestamp: string;
}

/**
 * Promote a parsed task that's missing `@id` by filling it in (always)
 * plus `@created` (if also missing). Returns the rewritten line, or
 * `null` if no promotion applies — line isn't a task, or it already
 * carries an `@id`.
 *
 * **Marker-agnostic.** Promotes whatever marker the task carries
 * (`- [ ]`, `- [/]`, `- [x]`, `- [n]`, etc.) without rewriting it. The
 * Alt+A toggle mutator gates this on a specific target marker; the
 * code-action provider gates on "any markered task" so a user can
 * promote a hand-typed `- [x] done` in place too.
 *
 * `deps.generateId` / `deps.now` are injected so the helper stays
 * pure and deterministically testable.
 */
export function promoteMissingMetadata(
    line: string,
    deps: { generateId: () => string; now: () => string },
): string | null {
    const parsed = parseLine(line);
    if (!parsed || parsed.metadata.has('id')) return null;
    let next = setMetadataEntry(line, 'id', deps.generateId());
    if (!parsed.metadata.has('created')) {
        next = setMetadataEntry(next, 'created', deps.now());
    }
    return next;
}

/**
 * Convert a non-task line into a task with `@id` + `@created` metadata.
 *
 * - Empty line (possibly whitespace-only) → `- [m]  <!-- @id:… @created:… -->`
 *   with the existing leading whitespace preserved as indent. The **two**
 *   spaces between marker and metadata are intentional: paired with the
 *   cursor-positioning logic in `toggle-commands.ts:applyEdit`, the cursor
 *   lands between the two spaces so the user's first keystroke produces
 *   `- [m] foo <!-- ... -->` — well-spaced — instead of `- [m] foo<!--...`.
 *   The Enter-continuation path in `list-edit.ts:computeEnterEdit` emits the
 *   same shape for the same reason.
 * - Bare bullet (`- foo`, `* foo`, indented) → `- [m] foo <!-- … -->`: the
 *   existing list marker is **stripped, not doubled** (so `- milk` becomes
 *   `- [ ] milk`, never `- [ ] - milk`) and canonicalised to `-`. An empty
 *   bullet (`- `) wraps to the empty-task shape above.
 * - Non-empty plain line → `- [m] <content> <!-- … -->` with the original
 *   content preserved verbatim (trimmed only on the right) and the line's
 *   leading whitespace preserved as indent.
 * - Existing task → unchanged. Use `swapMarker` to change a task's marker.
 *
 * `id` and `timestamp` are injected so the helper stays pure and
 * deterministically testable.
 */
export function wrapAsTask(line: string, marker: Marker, opts: WrapOpts): string {
    if (parseLine(line) !== null) return line;
    // A bare bullet wraps by its content only — strip the existing marker so
    // `- milk` → `- [ ] milk` (not `- [ ] - milk`). Otherwise the indent is the
    // leading whitespace and the content is the rest of the line.
    const bullet = parseBullet(line);
    const indent = bullet ? bullet.indent : (/^\s*/.exec(line)?.[0] ?? '');
    const content = bullet ? bullet.content : line.slice(indent.length).trimEnd();
    const metadataComment = `<!-- @id:${opts.id} @created:${opts.timestamp} -->`;
    const prefix = `${indent}- [${CANONICAL_SYMBOL[marker]}]`;
    return content === ''
        ? `${prefix}  ${metadataComment}`
        : `${prefix} ${content} ${metadataComment}`;
}

/**
 * Column where the cursor should land after a line is freshly wrapped into a
 * task — the start of where the user types content next, kept *before* the
 * trailing `<!-- … -->` metadata.
 *
 * - Empty-content task (`- [m]··<!-- … -->`) → between the two spacer spaces
 *   (`prefixEnd`), so the first keystroke yields a well-spaced
 *   `- [m] foo <!-- … -->`. (Matches the long-standing empty-wrap behavior.)
 * - Content task (`- [m] foo <!-- … -->`) → just past the content, before the
 *   space that precedes `<!--`, so Alt+A on `buy milk` leaves the cursor ready
 *   to keep editing the task text rather than stranded after the metadata.
 *
 * Returns null for a non-task line. Pure — pairs with `applyEdit`'s post-edit
 * cursor move and mirrors the Enter-continuation target in `computeEnterEdit`.
 */
export function contentCursorCol(line: string): number | null {
    const parsed = parseLine(line);
    if (!parsed) return null;
    const bracketStart = parsed.raw.indexOf('[', parsed.indent.length);
    if (bracketStart < 0) return null;
    const prefixEnd = bracketStart + 4;
    if (parsed.content === '') return prefixEnd;
    const metadataStart = parsed.raw.indexOf('<!--', prefixEnd);
    let contentEnd = metadataStart >= 0 ? metadataStart : parsed.raw.length;
    while (contentEnd > prefixEnd && /\s/.test(parsed.raw.charAt(contentEnd - 1))) {
        contentEnd--;
    }
    return contentEnd;
}

/**
 * Convert an empty task line back into a (possibly indented) blank line.
 * Tasks with any content pass through unchanged — we never blow away user
 * text. Non-task lines pass through too.
 *
 * "Empty" here means `parsed.content === ''` — the task may still carry
 * metadata, which is the typical "fresh `toggleTodo`" state. Unwrapping
 * drops the bullet, marker, and metadata; the indent stays so the cursor
 * column doesn't jump.
 */
export function unwrapTask(line: string): string {
    const parsed = parseLine(line);
    if (!parsed) return line;
    if (parsed.content !== '') return line;
    return parsed.indent;
}

/**
 * Set `@key:value` on a task line. Overwrites any existing value. The
 * metadata comment is created if not yet present. Non-task lines pass through.
 */
export function setMetadataEntry(line: string, key: string, value: string | null): string {
    if (parseLine(line) === null) return line;
    return replaceMetadata(line, (meta) => {
        meta.set(key, value);
    });
}

/**
 * Remove `@key` from a task line. No-op if absent. Non-task lines pass
 * through.
 */
export function removeMetadataEntry(line: string, key: string): string {
    if (parseLine(line) === null) return line;
    return replaceMetadata(line, (meta) => {
        meta.delete(key);
    });
}

/**
 * Toggle a `@key:value` entry on a task line:
 *
 * - Absent → add with the given `value`.
 * - Present with matching `value` → remove.
 * - Present with mismatched value → overwrite to `value`.
 *
 * Non-task lines pass through unchanged.
 *
 * The "mismatched → overwrite" branch is what makes the priority toggles'
 * mutual exclusion fall out automatically: `toggleMetadataEntry(line,
 * 'priority', '2')` against a `@priority:1` line writes `@priority:2`
 * without a separate clear-step.
 */
export function toggleMetadataEntry(line: string, key: string, value: string | null): string {
    if (parseLine(line) === null) return line;
    return replaceMetadata(line, (meta) => {
        if (meta.has(key) && meta.get(key) === value) {
            meta.delete(key);
        } else {
            meta.set(key, value);
        }
    });
}
