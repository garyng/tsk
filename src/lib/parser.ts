/**
 * Canonical task-marker names. Lowercase by convention; the parser accepts
 * both cases on read (`[x]` / `[X]`) but always returns the lowercase form.
 */
export type Marker = 'todo' | 'inprogress' | 'completed' | 'moved' | 'cancelled' | 'notes';

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
}

export interface Task extends ParsedTask {
    /** Zero-indexed line number in the source document (matches VSCode's API). */
    line: number;
}

const TASK_LINE_RE = /^(\s*)[-*+]\s+\[([ /xX>!nN])\]\s*(.*)$/;
const COMMENT_RE = /<!--([\s\S]*?)-->/g;
const METADATA_ENTRY_RE = /@([A-Za-z][A-Za-z0-9_]*)(?::((?:(?!-->)\S)*))?/g;
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
    const marker = canonicalMarker(markerChar as string);
    if (!marker) return null;

    const metadata = new Map<string, string | null>();
    const content = (rest as string)
        .replace(COMMENT_RE, (_, inner: string) => {
            for (const entry of inner.matchAll(METADATA_ENTRY_RE)) {
                const key = entry[1] as string;
                const value = entry[2] ?? null;
                metadata.set(key, value);
            }
            return '';
        })
        .trim();

    const tags: string[] = [];
    for (const tagMatch of content.matchAll(TAG_RE)) {
        tags.push(tagMatch[1] as string);
    }

    return { marker, indent: indent as string, content, metadata, tags };
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

function canonicalMarker(ch: string): Marker | null {
    switch (ch) {
        case ' ':
            return 'todo';
        case '/':
            return 'inprogress';
        case 'x':
        case 'X':
            return 'completed';
        case '>':
            return 'moved';
        case '!':
            return 'cancelled';
        case 'n':
        case 'N':
            return 'notes';
        default:
            return null;
    }
}
