import { MARKERS, type Marker } from './markers';
import { replaceMetadata } from './metadata';
import { parseLine } from './parser';

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
    const indentMatch = /^\s*/.exec(line);
    const indent = indentMatch ? indentMatch[0] : '';
    const content = line.slice(indent.length).trimEnd();
    const metadataComment = `<!-- @id:${opts.id} @created:${opts.timestamp} -->`;
    const prefix = `${indent}- [${CANONICAL_SYMBOL[marker]}]`;
    return content === ''
        ? `${prefix}  ${metadataComment}`
        : `${prefix} ${content} ${metadataComment}`;
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
