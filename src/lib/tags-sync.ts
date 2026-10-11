/**
 * Pure core of `Tsk: Add Discovered Tags to tags.yml` — diff the tags
 * discovered in the workspace against those already declared in `tags.yml`,
 * and render append-only stub text for the difference — and of
 * `Tsk: Define Tag in tags.yml…`, which appends one described entry
 * ({@link buildTagEntryText}).
 *
 * Append-only and comment-preserving by construction: the command never
 * rewrites the existing document, it only computes text to add at the end,
 * so every existing entry, description, and comment survives byte-for-byte.
 *
 * Pure — no I/O, no vscode. The command supplies the discovered/declared
 * sets (cache + parsed yaml), the date (for deterministic tests), and the
 * document's eol.
 */

import { parse as parseYaml } from 'yaml';

/**
 * The tags present in `discovered` but absent from `declared`, sorted and
 * de-duplicated. Empty strings are skipped (a real tag can never be empty —
 * the parser's `#[A-Za-z]…` rule guarantees a leading letter — but the guard
 * keeps a malformed cache row from emitting a `:`-only yaml line).
 */
export function computeMissingTags(
    discovered: Iterable<string>,
    declared: Iterable<string>,
): string[] {
    const declaredSet = new Set(declared);
    const missing = new Set<string>();
    for (const tag of discovered) {
        if (tag !== '' && !declaredSet.has(tag)) missing.add(tag);
    }
    return [...missing].sort();
}

/**
 * The text to append to (or, for a new file, the whole content of) a
 * `tags.yml` so every tag in `missing` gains a bare stub entry under a dated
 * header comment. Returns `''` when `missing` is empty so the caller writes
 * nothing.
 *
 * Keys go through {@link yamlKey}: the tag charset rules out indicator and
 * flow characters, but not YAML's core-schema keywords, so a tag like `null`
 * or `True` has to be quoted to survive. Round-trip tests cover both.
 *
 * Separator: an empty `existingText` yields the block alone (the new file's
 * content); otherwise a blank line precedes the header — one `eol` when the
 * file already ends in a newline, two when it doesn't — so the header never
 * glues onto the last existing line.
 */
export function buildTagsAppendText(
    existingText: string,
    missing: readonly string[],
    today: string,
    eol: string,
): string {
    if (missing.length === 0) return '';
    const header = `# discovered ${today} — fill in description / parent`;
    const entries = missing.map((tag) => `${yamlKey(tag)}:`).join(eol);
    const block = `${header}${eol}${entries}${eol}`;
    if (existingText === '') return block;
    const separator = existingText.endsWith('\n') ? eol : `${eol}${eol}`;
    return `${separator}${block}`;
}

/**
 * Text appending ONE tag with a description, in the string-shorthand form
 * (`tag: "description"`). Like {@link buildTagsAppendText} it never glues onto
 * the last existing line, but it adds no blank line: nothing when the file
 * already ends in a newline, one `eol` otherwise.
 *
 * The description is always double-quoted via `JSON.stringify`. It is free
 * text the user just typed, and a `: ` in it, or a leading `#`, `-` or `{`,
 * would change or break the parse — while naive hand-quoting would trip on an
 * embedded `"`. YAML's double-quoted scalar accepts JSON's escapes, so this
 * needs no bespoke escaper.
 */
export function buildTagEntryText(
    existingText: string,
    tag: string,
    description: string,
    eol: string,
): string {
    const entry = `${yamlKey(tag)}: ${JSON.stringify(description)}${eol}`;
    if (existingText === '') return entry;
    const separator = existingText.endsWith('\n') ? '' : eol;
    return `${separator}${entry}`;
}

/**
 * `tag` written as a YAML mapping key that re-parses to exactly `tag`: plain
 * when it already does, double-quoted when it doesn't.
 *
 * The tag charset (`[A-Za-z][A-Za-z0-9_/-]*`) excludes indicator and flow
 * characters but not YAML's core-schema keywords. Unquoted, `null:` re-parses
 * as an empty key — which `parseTagsYaml` then drops, silently losing the
 * declaration — and `True:` comes back as `true`, so a lookup by name misses.
 * Asking the parser itself avoids maintaining a keyword list that could drift
 * from the schema it's guarding against.
 */
export function yamlKey(tag: string): string {
    const parsed = parseYaml(`${tag}: 0`) as Record<string, unknown> | null;
    return Object.keys(parsed ?? {})[0] === tag ? tag : JSON.stringify(tag);
}
