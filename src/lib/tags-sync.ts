/**
 * Pure core of `Tsk: Add Discovered Tags to tags.yml` — diff the tags
 * discovered in the workspace against those already declared in `tags.yml`,
 * and render append-only stub text for the difference.
 *
 * Append-only and comment-preserving by construction: the command never
 * rewrites the existing document, it only computes text to add at the end,
 * so every existing entry, description, and comment survives byte-for-byte.
 *
 * Pure — no I/O, no vscode. The command supplies the discovered/declared
 * sets (cache + parsed yaml), the date (for deterministic tests), and the
 * document's eol.
 */

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
 * Tags are charset-restricted by the parser (`#[A-Za-z][A-Za-z0-9_/-]*`), so
 * they are always safe as UNQUOTED yaml block-mapping keys (no indicator/flow
 * chars, no `:`/space/`#`) — no quoting needed. A round-trip test proves the
 * output re-parses to exactly these keys.
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
    const entries = missing.map((tag) => `${tag}:`).join(eol);
    const block = `${header}${eol}${entries}${eol}`;
    if (existingText === '') return block;
    const separator = existingText.endsWith('\n') ? eol : `${eol}${eol}`;
    return `${separator}${block}`;
}
