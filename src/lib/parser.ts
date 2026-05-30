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
const BULLET_LINE_RE = /^(\s*)([-*+])(\s+)(.*)$/;

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

export interface ParsedBullet {
    /** Literal leading whitespace (spaces and/or tabs), preserved verbatim. */
    indent: string;
    /** The list-marker character — `-`, `*`, or `+`. */
    bullet: string;
    /**
     * Text after the marker and its trailing spaces, right-trimmed. Empty for a
     * bare `- ` with no content. **Not** metadata-stripped: a bare bullet carries
     * no tsk metadata, so the raw remainder *is* the content.
     */
    content: string;
    /** Column in `raw` where `content` begins (past the marker + its spaces). */
    contentStart: number;
    /** The original line text (minus a trailing `\r` if the caller passed one). */
    raw: string;
}

/**
 * Parse a *bare* markdown list item: a `-`/`*`/`+` bullet followed by at least
 * one space, that is **not** a tsk task (`parseLine` returns null for it).
 *
 * Returns null for task lines (`- [ ] foo`), non-list lines, and a lone marker
 * with no following space (`-`). Bare bullets are the checkbox-less nested list
 * items a user writes under a task; the list-edit + wrap helpers give them
 * Markdown-All-in-One semantics. Pure — no I/O, no side effects.
 */
export function parseBullet(line: string): ParsedBullet | null {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    // A task is also a bullet syntactically; exclude it so "bare bullet" and
    // "task" stay disjoint and callers can branch on one helper at a time.
    if (parseLine(normalized) !== null) return null;
    const match = BULLET_LINE_RE.exec(normalized);
    if (!match) return null;
    const [, indent, bullet, spaces, rest] = match;
    return {
        indent: indent as string,
        bullet: bullet as string,
        content: (rest as string).trimEnd(),
        contentStart: (indent as string).length + 1 + (spaces as string).length,
        raw: normalized,
    };
}
