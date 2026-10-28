import GithubSlugger, { slug } from 'github-slugger';
import { marked } from 'marked';

/**
 * Where a `[[file.md#heading]]` lands, pure. The anchor is GitHub's — what a
 * reader copies from GitHub or VS Code's own Markdown links — so the slug is
 * `github-slugger`'s (GitHub's algorithm, numbering a repeated heading `-1`,
 * `-2`), over the heading's rendered text. The headings come from `marked`'s
 * lexer, which skips fenced code; only top-level ones count, not a heading
 * inside a list or a quote. Link resolution and `#` completion both read
 * `markdownHeadings`, so they can't disagree about an anchor.
 */

/** A top-level heading: its rendered text, the anchor GitHub gives it, its zero-based line. */
export interface MarkdownHeading {
    text: string;
    anchor: string;
    line: number;
}

/** Every top-level heading in `markdown`, in order. */
export function markdownHeadings(markdown: string): MarkdownHeading[] {
    const src = markdown.replace(/\r\n?/g, '\n');
    const slugger = new GithubSlugger();
    const headings: MarkdownHeading[] = [];
    let at = 0;
    for (const token of marked.lexer(src)) {
        const start = src.indexOf(token.raw, at);
        if (start >= 0) at = start + token.raw.length;
        if (token.type !== 'heading') continue;
        const text = (token.tokens ?? []).map((t) => ('text' in t ? t.text : '')).join('');
        // Slugged even when unplaced, so the numbering of a repeat stays GitHub's.
        const anchor = slugger.slug(text);
        if (start >= 0) headings.push({ text, anchor, line: lineAt(src, start) });
    }
    return headings;
}

/** The zero-based line of the heading `fragment` names — its anchor, or its text — in `markdown`. */
export function headingLine(markdown: string, fragment: string): number | undefined {
    return headingFor(markdownHeadings(markdown), fragment)?.line;
}

/** The heading among `headings` that `fragment` names, by its anchor or its text. */
export function headingFor(
    headings: readonly MarkdownHeading[],
    fragment: string,
): MarkdownHeading | undefined {
    const want = slug(safeDecode(fragment));
    return headings.find((heading) => heading.anchor === want);
}

/** A fragment copied from an address bar is percent-encoded; one typed by hand may hold a bare `%`. */
function safeDecode(fragment: string): string {
    try {
        return decodeURIComponent(fragment);
    } catch {
        return fragment;
    }
}

function lineAt(src: string, offset: number): number {
    let line = 0;
    for (let i = src.indexOf('\n'); i !== -1 && i < offset; i = src.indexOf('\n', i + 1)) line++;
    return line;
}
