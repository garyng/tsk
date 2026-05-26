import { MARKER_SYMBOL_CHAR_CLASS, type Marker, markerForSymbol } from './markers';
import { extractMetadata } from './metadata';

/**
 * Canonical task-marker names. Re-exported here so downstream code can
 * continue to import from `./parser`; the source of truth is `./markers`.
 */
export type { Marker };

export interface ParsedTask {
    /** Canonical marker name. */
    marker: Marker;
    /** Literal leading whitespace (spaces and/or tabs), preserved verbatim. */
    indent: string;
    /**
     * Task content with inline `<!-- ... -->` metadata comments stripped and
     * outer whitespace trimmed. Tags (`#foo`) are retained in the text.
     */
    content: string;
    /**
     * Inline `@key:value` pairs in appearance order. Insertion order matters
     * because the serializer preserves it on round-trip. A `null` value
     * distinguishes `@flag` (no colon) from `@flag:` (colon, empty value).
     */
    metadata: Map<string, string | null>;
    /** Tag names without the `#` prefix, in appearance order in `content`. */
    tags: string[];
    /**
     * The original line text, byte-for-byte (minus a trailing `\r` if the
     * caller passed a CRLF-split line). Lets downstream consumers (cache,
     * codelens, `replaceMetadata`) operate on the source without re-fetching it.
     */
    raw: string;
}

export interface Task extends ParsedTask {
    /** Zero-indexed line number in the source document (matches VSCode's API). */
    line: number;
}

const TASK_LINE_RE = new RegExp(`^(\\s*)[-*+]\\s+\\[([${MARKER_SYMBOL_CHAR_CLASS}])\\]\\s*(.*)$`);
const TAG_RE = /(?:^|\s)#([A-Za-z][A-Za-z0-9_/-]*)/g;

/**
 * Parse a single line. Returns `null` if the line is not a recognizable task.
 * Pure — no I/O, no side effects.
 */
export function parseLine(line: string): ParsedTask | null {
    // Tolerate a trailing `\r` if the caller passed a CRLF-split line.
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    const match = TASK_LINE_RE.exec(normalized);
    if (!match) return null;

    const [, indent, markerChar, rest] = match;
    const marker = markerForSymbol(markerChar as string);
    if (!marker) return null;

    const { metadata, stripped } = extractMetadata(rest as string);
    const content = stripped.trim();

    const tags: string[] = [];
    for (const tagMatch of content.matchAll(TAG_RE)) {
        tags.push(tagMatch[1] as string);
    }

    return { marker, indent: indent as string, content, metadata, tags, raw: normalized };
}

/**
 * Parse a whole document. Splits on `\n` (CRLF tolerated via `parseLine`'s
 * trim) and returns one `Task` per line that parses successfully, each
 * tagged with its zero-indexed line number. Pure.
 */
export function parseDocument(text: string): Task[] {
    const lines = text.split(/\r?\n/);
    const tasks: Task[] = [];
    for (let i = 0; i < lines.length; i++) {
        const parsed = parseLine(lines[i] as string);
        if (parsed) {
            tasks.push({ ...parsed, line: i });
        }
    }
    return tasks;
}
