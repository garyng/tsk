/**
 * What `findTagPrefixContext` returns when the cursor is inside (or
 * immediately after) a `#tag` token. `startCol` and `endCol` bracket the
 * tag-name characters (i.e. they exclude the `#` itself and the leading
 * whitespace anchor). `partial` is the substring between the `#` and the
 * cursor — that's what VSCode filters the completion list against.
 */
export interface TagPrefixContext {
    /** Column right after the `#` — where the tag name begins. */
    startCol: number;
    /**
     * Column right after the last tag-name character following the
     * cursor. Equal to `cursorCol` when the cursor sits at the end of
     * the partial; greater when the cursor is mid-word (e.g.
     * `#proj|ect` → endCol points past `t`).
     */
    endCol: number;
    /** Text typed between the `#` and the cursor. */
    partial: string;
}

const TAG_CHAR_RE = /[\w/-]/;

/**
 * Inspect a line + cursor column and decide whether the cursor is
 * inside a `#tag` token that we should offer completion for. Returns
 * `undefined` when the cursor isn't completing a tag — caller's signal
 * to skip the completion provider.
 *
 * Anchor rule mirrors the parser's tag regex: the `#` must be at the
 * start of the line or follow whitespace. This keeps the provider
 * silent inside `###markdown` heading markers (where consecutive `#`s
 * aren't tag boundaries) while still firing for `# parent: #child`
 * patterns where a real tag follows a space.
 *
 * Tag-name char class: `[\w/-]` — matches the parser's
 * `[A-Za-z0-9_/-]` greedy tail. The parser also requires the first
 * char after `#` to be a letter; the completion provider deliberately
 * does NOT enforce that, so a user mid-typing `#1` still triggers the
 * suggestion list (VSCode's filter handles the case where nothing
 * matches).
 */
export function findTagPrefixContext(
    line: string,
    cursorCol: number,
): TagPrefixContext | undefined {
    let start = cursorCol;
    while (start > 0) {
        const ch = line[start - 1];
        if (ch === undefined || !TAG_CHAR_RE.test(ch)) break;
        start--;
    }
    if (start === 0 || line[start - 1] !== '#') return undefined;
    const hashCol = start - 1;
    if (hashCol > 0) {
        const before = line[hashCol - 1];
        if (before !== undefined && !/\s/.test(before)) return undefined;
    }
    let end = cursorCol;
    while (end < line.length) {
        const ch = line[end];
        if (ch === undefined || !TAG_CHAR_RE.test(ch)) break;
        end++;
    }
    return { startCol: start, endCol: end, partial: line.slice(start, cursorCol) };
}

/**
 * Build the `filterText` for a tag completion item. VSCode runs fuzzy
 * matching against this string, so embedding the yaml description
 * alongside the name lets users find a tag by typing words from its
 * description (e.g. typing `infra` surfaces `homelab` if its yaml
 * description is "Self-hosted infrastructure").
 *
 * **Ordering is load-bearing.** Name comes first so an exact-prefix
 * match against the tag name still scores higher than a partial match
 * inside the description text — typing `mile` still ranks
 * `milestone/M3` above any tag whose description happens to contain
 * "mile" mid-word.
 */
export function buildTagFilterText(name: string, description: string | undefined): string {
    if (!description) return name;
    return `${name} ${description}`;
}
