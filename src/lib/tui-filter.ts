import escapeStringRegexp from 'escape-string-regexp';
import stringWidth from 'string-width';

/**
 * The tree view's `/` filter, pure: which tasks a query picks,
 * where its terms fall in a row's text for the highlight, and which part of a
 * long query the footer's prompt shows. A query is space-separated terms; a
 * task matches when each term is in its text as the row shows it, or starts
 * its `@id`, ignoring case. Substrings, not fuzzy: over sentence-long tasks
 * fuzzy matching finds too much.
 */

/** The query's terms: split at spaces, empty ones dropped. */
export function filterTerms(query: string): string[] {
    return query.split(/\s+/).filter((t) => t !== '');
}

/** A term found in a text, at UTF-16 offsets, `end` exclusive. */
export interface TextRange {
    readonly start: number;
    readonly end: number;
}

/**
 * A test of a task's text and `@id` against `terms`. A regex per term rather
 * than `toLowerCase().includes`: lower-casing can change a string's length,
 * and {@link termRanges} needs offsets into the text as written.
 */
export function termMatcher(terms: readonly string[]): (text: string, id?: string) => boolean {
    const tests = terms.map((t) => ({ re: termPattern(t, 'iu'), term: t }));
    return (text, id) => tests.every((t) => startsId(id, t.term) || t.re.test(text));
}

/**
 * How much of `id` a row shows as matched: the longest term only the id
 * holds — starting it, and not in the text — so the row can say why it's
 * there. 0 when the text holds every term the id does.
 */
export function idMatchLength(text: string, id: string | undefined, terms: readonly string[]) {
    const byId = terms.filter((t) => startsId(id, t) && !termPattern(t, 'iu').test(text));
    return Math.max(0, ...byId.map((t) => t.length));
}

/** Whether `term` starts `id`, ignoring case: the ids are ASCII, so lower-casing keeps lengths. */
const startsId = (id: string | undefined, term: string) =>
    id?.toLowerCase().startsWith(term.toLowerCase()) === true;

/** Where each term occurs in `text`, ignoring case: sorted, overlapping ones merged. */
export function termRanges(text: string, terms: readonly string[]): TextRange[] {
    const found = terms
        .flatMap((t) => [...text.matchAll(termPattern(t, 'giu'))])
        .map((m) => ({ start: m.index, end: m.index + m[0].length }))
        .sort((a, b) => a.start - b.start);
    const merged: TextRange[] = [];
    for (const r of found) {
        const last = merged.at(-1);
        if (last && r.start <= last.end) {
            merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, r.end) };
        } else merged.push(r);
    }
    return merged;
}

const termPattern = (term: string, flags: string) => new RegExp(escapeStringRegexp(term), flags);

/**
 * The part of a one-line input shown in `room` columns with its cursor in
 * view: from the start while the cursor fits there, else scrolled just far
 * enough. The cursor takes a column of its own past the last character.
 */
export function inputWindow(text: string, cursor: number, room: number): TextRange {
    const cols = Math.max(1, room);
    const chars = [...text];
    const widths = chars.map((ch) => stringWidth(ch));
    const offsets = [0];
    for (const ch of chars) offsets.push((offsets.at(-1) ?? 0) + ch.length);
    // The cursor's character; the cursor is always between two.
    const at = Math.max(0, offsets.indexOf(cursor));
    const sum = (from: number, to: number) => widths.slice(from, to).reduce((a, b) => a + b, 0);
    let start = 0;
    while (start < at && sum(start, at) + Math.max(1, widths[at] ?? 1) > cols) start++;
    let end = start;
    while (end < chars.length && sum(start, end + 1) <= cols) end++;
    return { start: offsets[start] ?? 0, end: offsets[end] ?? text.length };
}
