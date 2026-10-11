/**
 * Locating a `#tag` — under the cursor in a `.tsk` line, and by name in a
 * `tags.yml` document.
 *
 * Both are pure and both exist because the things that already know about
 * tags throw position information away: `parseLine` reports a task's tags as
 * bare names, and `parseTagsYaml` returns a `Map` with no line numbers.
 */

/**
 * Tags, matched the same way `parser.ts`'s `TAG_RE` does — the `(?:^|\s)`
 * prefix is what stops a `#` inside a word (or a URL fragment) counting. Kept
 * as its own instance rather than imported because a `g`-flagged regex carries
 * mutable `lastIndex`, and sharing one across modules invites a stale-state
 * bug.
 */
const TAG_RE = /(?:^|\s)#([A-Za-z][A-Za-z0-9_/-]*)/g;

/** A `#tag` occurrence on one line (cols are 0-based, `endCol` exclusive). */
export interface TagSpan {
    /** Column of the `#`. */
    startCol: number;
    /** Column just past the tag name. */
    endCol: number;
    /** The tag name, without the `#`. */
    tag: string;
}

/**
 * The tag the cursor is on, or `null`. The cursor counts as "on" the tag
 * anywhere from the `#` through the character just past the name, so
 * ctrl+clicking the last letter works and so does a cursor resting at the end
 * of the word.
 */
export function tagSpanAt(lineText: string, character: number): TagSpan | null {
    for (const match of lineText.matchAll(TAG_RE)) {
        const name = match[1] as string;
        // match[0] may carry the leading whitespace the lookbehind-free
        // pattern has to consume, so find the `#` inside it.
        const startCol = match.index + match[0].indexOf('#');
        const endCol = startCol + 1 + name.length;
        if (character >= startCol && character <= endCol) {
            return { startCol, endCol, tag: name };
        }
    }
    return null;
}

/**
 * The 0-based line in `yamlText` that declares `tag`, or `null`.
 *
 * A text search rather than a parse, deliberately: `parseTagsYaml` discards
 * positions, and reconstructing them would mean re-implementing enough YAML to
 * track offsets. Matching `^<indent><tag>:` handles both accepted schema forms
 * (string shorthand and the object form) because they differ only after the
 * colon, and the quoted-key form is handled too since a key may legitimately
 * be written `'p/tsk':`.
 */
export function findTagDeclarationLine(yamlText: string, tag: string): number | null {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^\\s*(["']?)${escaped}\\1\\s*:`);
    const lines = yamlText.split(/\r?\n/);
    for (let line = 0; line < lines.length; line++) {
        if (re.test(lines[line] as string)) return line;
    }
    return null;
}
