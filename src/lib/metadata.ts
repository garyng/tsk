/**
 * Inline-metadata read/write helpers. Single source of truth for the
 * `<!-- @key:value ... -->` comment shape; `parser.ts` consumes these
 * exports so parse → serialize is lossless by construction.
 *
 * Pure — no I/O.
 */

const COMMENT_RE = /<!--([\s\S]*?)-->/g;
const METADATA_ENTRY_RE = /@([A-Za-z][A-Za-z0-9_]*)(?::((?:(?!-->)\S)*))?/g;

/**
 * Single-pass split of `text` into its metadata and its non-metadata parts.
 *
 * - `metadata`: insertion-ordered Map of every `@key:value` found across
 *   every `<!-- ... -->` comment block, in appearance order. Later
 *   occurrences of the same key overwrite earlier ones.
 * - `stripped`: `text` with every `<!-- ... -->` block removed.
 *
 * One `.replace` traversal: the callback accumulates entries into the Map
 * while returning the empty string for each match.
 */
export function extractMetadata(text: string): {
    metadata: Map<string, string | null>;
    stripped: string;
} {
    const metadata = new Map<string, string | null>();
    const stripped = text.replace(COMMENT_RE, (_, inner: string) => {
        for (const entry of inner.matchAll(METADATA_ENTRY_RE)) {
            metadata.set(entry[1] as string, entry[2] ?? null);
        }
        return '';
    });
    return { metadata, stripped };
}

/**
 * The `[start, end)` index span of every `<!-- ... -->` comment block in
 * `text`, in appearance order. Reuses {@link COMMENT_RE} — the single owner of
 * the comment shape — so the decoration dimmer consumes this instead of
 * re-declaring its own copy of the pattern.
 */
export function findMetadataCommentSpans(text: string): Array<{ start: number; end: number }> {
    const spans: Array<{ start: number; end: number }> = [];
    for (const match of text.matchAll(COMMENT_RE)) {
        if (match.index === undefined) continue;
        spans.push({ start: match.index, end: match.index + match[0].length });
    }
    return spans;
}

/**
 * Render a metadata Map back into an inline comment.
 *
 * - Empty Map → `""` (caller appends nothing).
 * - `null` value → `@flag` (no colon).
 * - `""` value → `@flag:` (colon, empty value — distinct from `null` on purpose).
 * - Non-empty value → `@key:value`.
 *
 * Insertion order is preserved (JavaScript `Map` semantics).
 */
export function serializeMetadata(metadata: Map<string, string | null>): string {
    if (metadata.size === 0) return '';
    const entries: string[] = [];
    for (const [key, value] of metadata) {
        entries.push(value === null ? `@${key}` : `@${key}:${value}`);
    }
    return `<!-- ${entries.join(' ')} -->`;
}

/**
 * Apply an in-place mutation to a line's inline metadata.
 *
 * Steps: extract every existing `@key:value` from every comment in the
 * line into a single insertion-ordered Map; invoke the mutator (which
 * calls `map.set` / `map.delete` directly); strip all existing comments;
 * re-emit a single fresh comment at the end if the resulting Map is
 * non-empty.
 *
 * Preservation guarantees:
 * - Untouched keys keep their position relative to other untouched keys.
 * - `map.set(k, v)` on an existing key updates value without moving the key.
 * - New keys are appended at the end.
 * - Lines without any metadata comment, when the mutator leaves the Map
 *   empty, are returned byte-for-byte unchanged.
 *
 * Trailing whitespace before the (now-removed) comment is trimmed so the
 * round-trip doesn't gradually accumulate spaces. Indent (leading
 * whitespace) is preserved verbatim.
 */
export function replaceMetadata(
    line: string,
    mutator: (metadata: Map<string, string | null>) => void,
): string {
    const { metadata, stripped } = extractMetadata(line);
    const hadComment = stripped !== line;

    mutator(metadata);

    const serialized = serializeMetadata(metadata);

    if (!serialized) {
        // No metadata to write. If the line never had a comment to begin
        // with, return it untouched (preserves trailing whitespace the
        // caller may have intentionally placed). Otherwise return the
        // stripped line with any leftover trailing whitespace cleaned up.
        return hadComment ? stripped.replace(/[ \t]+$/, '') : line;
    }

    return `${stripped.replace(/[ \t]+$/, '')} ${serialized}`;
}
