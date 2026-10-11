/**
 * Pure core of the `[[wiki link]]` feature: find the link spans on a line,
 * decide whether the cursor sits inside an unclosed `[[…`, and turn a link's
 * text into the filesystem candidates it could mean. No `vscode` import — the
 * activation layer (`wiki-link-provider.ts`) maps spans onto
 * `vscode.DocumentLink`s and does the I/O, the same split
 * `lib/autolinks.ts` ↔ `autolinks-provider.ts` uses.
 *
 * The syntax is a workspace-relative path and nothing else:
 * `[[notes/2026-01-15_kickoff.md]]`. There is deliberately no display-text
 * form (`[[path|label]]`) and no `@id` form — task-to-task references are
 * `@parent` / `@relatedTo` / `@dependsOn`, which already have codelens
 * navigation, and giving `[[…]]` a second meaning would make "where does this
 * go?" ambiguous.
 */

import { isAbsolute, join, normalize } from 'node:path';

/** A resolved link location on one line (cols are 0-based, `endCol` exclusive). */
export interface WikiLinkSpan {
    /** Column of the first `[`. */
    startCol: number;
    /** Column just past the final `]`. */
    endCol: number;
    /** The text between the brackets, trimmed. Never empty. */
    path: string;
}

/**
 * `[[…]]` with at least one inner character and no brackets inside. Excluding
 * `[` and `]` from the inner class keeps `[[a]] and [[b]]` two links rather
 * than one greedy span, and makes `[[]]` a non-match (nothing to resolve).
 */
const WIKI_LINK_RE = /\[\[([^[\]\n]+)\]\]/g;

/** Every `[[…]]` on `lineText`, left to right. */
export function wikiLinkSpans(lineText: string): WikiLinkSpan[] {
    const spans: WikiLinkSpan[] = [];
    for (const match of lineText.matchAll(WIKI_LINK_RE)) {
        const path = (match[1] as string).trim();
        if (path === '') continue; // `[[   ]]` — brackets with nothing in them.
        spans.push({
            startCol: match.index,
            endCol: match.index + match[0].length,
            path,
        });
    }
    return spans;
}

/** What the cursor is part-way through typing inside an unclosed `[[…`. */
export interface WikiLinkPrefix {
    /** Column of the first character AFTER the `[[` — where a completion starts replacing. */
    startCol: number;
    /** The partial path typed so far (may be empty, right after `[[`). */
    prefix: string;
}

/**
 * Is `character` (a 0-based cursor column) inside an unclosed `[[…`, and what
 * has been typed so far? Drives the completion provider, which is registered
 * on the `[` trigger character and therefore also fires on the FIRST `[` of a
 * pair — returning `null` there is what keeps completions out of ordinary
 * markdown links.
 */
export function wikiLinkPrefixAt(lineText: string, character: number): WikiLinkPrefix | null {
    const before = lineText.slice(0, character);
    const open = before.lastIndexOf('[[');
    if (open === -1) return null;
    const inner = before.slice(open + 2);
    // A bracket after the `[[` means this one is already closed (or malformed),
    // so the cursor is outside it: `[[a]] |` must not complete.
    if (inner.includes('[') || inner.includes(']')) return null;
    return { startCol: open + 2, prefix: inner };
}

/**
 * The paths a link's text could mean, in resolution order:
 * **workspace-relative first** (what the links already in use are written as),
 * then relative to the linking file's own directory. An absolute path is
 * returned alone. The caller takes the first that exists — keeping the I/O out
 * of here is what makes this testable.
 */
export function wikiPathCandidates(
    path: string,
    workspaceRoot: string | undefined,
    docDir: string | undefined,
): string[] {
    if (isAbsolute(path)) return [normalize(path)];
    const candidates: string[] = [];
    if (workspaceRoot !== undefined) candidates.push(normalize(join(workspaceRoot, path)));
    if (docDir !== undefined) {
        const fromDoc = normalize(join(docDir, path));
        if (!candidates.includes(fromDoc)) candidates.push(fromDoc);
    }
    return candidates;
}

/** A single-line text replacement: `[startCol, endCol)` becomes `text`. */
export interface WikiLinkInsert {
    startCol: number;
    endCol: number;
    text: string;
}

/**
 * The edit that inserts a link for `relPath` at a bare cursor. Two cases:
 * a cursor already inside an unclosed `[[…` completes that link in place
 * (adding the closing `]]` only if it isn't already there, so
 * `[[pl|]]` doesn't end up with four brackets); anywhere else inserts the
 * whole `[[…]]`.
 */
export function buildWikiLinkInsert(
    lineText: string,
    character: number,
    relPath: string,
): WikiLinkInsert {
    const open = wikiLinkPrefixAt(lineText, character);
    if (open === null) {
        return { startCol: character, endCol: character, text: `[[${relPath}]]` };
    }
    const closed = lineText.slice(character, character + 2) === ']]';
    return {
        startCol: open.startCol,
        endCol: character,
        text: closed ? relPath : `${relPath}]]`,
    };
}

/** One `[[…]]` whose target couldn't be resolved, located for a squiggle. */
export interface DanglingWikiLink {
    line: number;
    startCol: number;
    endCol: number;
    /** The unresolvable path, for the message. */
    path: string;
}

/**
 * Every unresolvable `[[…]]` in `lines`. `resolves` is injected so this stays
 * pure — the caller closes over the workspace root, the document's directory
 * and the filesystem. Unlike the cache's scan warnings (whole-line ranges),
 * the span is exact, so the squiggle sits on the brackets and nothing else.
 */
export function danglingWikiLinks(
    lines: readonly string[],
    resolves: (path: string) => boolean,
): DanglingWikiLink[] {
    const dangling: DanglingWikiLink[] = [];
    lines.forEach((text, line) => {
        for (const span of wikiLinkSpans(text)) {
            if (resolves(span.path)) continue;
            dangling.push({
                line,
                startCol: span.startCol,
                endCol: span.endCol,
                path: span.path,
            });
        }
    });
    return dangling;
}
