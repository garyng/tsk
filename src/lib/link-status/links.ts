// linkify-it 6 under an npm alias: 5 is the one `@types/markdown-it` imports as `linkify-it`
// (the preview plugin types against it), and 6's own types under that name would break it.
// 6 ends a URL at Unicode punctuation (`”`, `，`, `…`), which 5 takes as part of it.
import { LinkifyIt } from 'linkify-it-6';
import { type CompiledAutoLink, computeAutoLinkSpans } from '../autolinks';

/**
 * The links on a line whose status tsk can show: Markdown `[text](url)`, bare
 * `http(s)` URLs, and `tsk.autolinks` matches by their target. Pure; the
 * editor layer turns the spans into ranges.
 */

/** A link on one line: 0-based columns, `endCol` exclusive, and the URL it points to. */
export interface LinkSpan {
    readonly startCol: number;
    readonly endCol: number;
    readonly url: string;
}

// Only links with a scheme: a fuzzy `example.com` or an email has no status to fetch.
const linkify = new LinkifyIt({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
const WEB = new Set(['http:', 'https:']);

// `[text](url)` or `[text](url "title")`. The URL is linkify's to judge: a match it doesn't
// take as a link isn't one.
const MARKDOWN_LINK = /\[[^\]\n]*\]\(\s*<?([^\s<>()]+)>?(?:\s+"[^"]*")?\s*\)/g;

/**
 * Every link on `text`, left to right. Where they overlap, a Markdown link
 * wins over the URL inside it, and a URL over an autolink match inside it:
 * the URL's own status covers the ticket it names.
 */
export function findLinks(text: string, autolinks: readonly CompiledAutoLink[]): LinkSpan[] {
    const links: LinkSpan[] = [];
    const free = (start: number, end: number) =>
        links.every((l) => end <= l.startCol || start >= l.endCol);
    for (const m of text.matchAll(MARKDOWN_LINK)) {
        const url = m[1] ?? '';
        if (isWebUrl(url)) links.push({ startCol: m.index, endCol: m.index + m[0].length, url });
    }
    if (text.includes('://')) {
        for (const m of linkify.match(text) ?? []) {
            if (WEB.has(m.schema.toLowerCase()) && free(m.index, m.lastIndex))
                links.push({ startCol: m.index, endCol: m.lastIndex, url: m.url });
        }
    }
    for (const s of computeAutoLinkSpans(text, autolinks)) {
        if (isWebUrl(s.target) && free(s.startCol, s.endCol))
            links.push({ startCol: s.startCol, endCol: s.endCol, url: s.target });
    }
    return links.sort((a, b) => a.startCol - b.startCol);
}

function isWebUrl(url: string): boolean {
    const m = linkify.matchAtStart(url);
    return m !== null && m.lastIndex === url.length && WEB.has(m.schema.toLowerCase());
}
