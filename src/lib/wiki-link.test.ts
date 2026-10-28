import { describe, expect, it } from 'vitest';
import {
    buildWikiLinkInsert,
    danglingWikiLinks,
    headingPrefixOf,
    type WikiLinkProblem,
    type WikiLinkSpan,
    wikiLinkPrefixAt,
    wikiLinkSpans,
    wikiPathCandidates,
} from './wiki-link';

describe('wikiLinkSpans', () => {
    it('finds a link and reports the bracket-inclusive span', () => {
        // `- [n] [[a.md]]` — the span covers the brackets, the path does not.
        expect(wikiLinkSpans('- [n] [[a.md]]')).toEqual([
            { startCol: 6, endCol: 14, path: 'a.md' },
        ]);
    });

    it('reads the real-world form: a workspace-relative path inside a note task', () => {
        const line =
            '  - [n] [[notes/2026-01-15_kickoff.md]] <!-- @id:k1ck0ff1 @created:2026-01-15T09:00:00+00:00 -->';
        const spans = wikiLinkSpans(line);
        expect(spans).toHaveLength(1);
        expect(spans[0]?.path).toBe('notes/2026-01-15_kickoff.md');
        expect(line.slice(spans[0]?.startCol, spans[0]?.endCol)).toBe(
            '[[notes/2026-01-15_kickoff.md]]',
        );
    });

    it('keeps two links on one line separate', () => {
        expect(wikiLinkSpans('[[a.md]] and [[b.md]]').map((s) => s.path)).toEqual(['a.md', 'b.md']);
    });

    it('trims the inner text but not the span', () => {
        const spans = wikiLinkSpans('[[  a.md  ]]');
        expect(spans[0]?.path).toBe('a.md');
        expect(spans[0]).toMatchObject({ startCol: 0, endCol: 12 });
    });

    it('ignores brackets with nothing to resolve', () => {
        expect(wikiLinkSpans('[[]]')).toEqual([]);
        expect(wikiLinkSpans('[[   ]]')).toEqual([]);
    });

    it('is not fooled by single brackets or a markdown link', () => {
        expect(wikiLinkSpans('- [ ] a task')).toEqual([]);
        expect(wikiLinkSpans('[a link](https://example.com)')).toEqual([]);
        expect(wikiLinkSpans('[[unclosed')).toEqual([]);
        expect(wikiLinkSpans('unopened]]')).toEqual([]);
    });

    it('matches the inner pair when brackets are tripled', () => {
        // `[[[a]]]` — the inner class excludes brackets, so the match starts at 1.
        expect(wikiLinkSpans('[[[a]]]')).toEqual([{ startCol: 1, endCol: 6, path: 'a' }]);
    });

    it('accepts a path with spaces (a real filename may have them)', () => {
        expect(wikiLinkSpans('[[notes/my plan.md]]')[0]?.path).toBe('notes/my plan.md');
    });

    it('keeps a dangling path verbatim — resolution is the caller’s job', () => {
        // A trailing dot — a real-world typo that resolves to nothing.
        expect(wikiLinkSpans('[[notes/kickoff.md.]]')[0]?.path).toBe('notes/kickoff.md.');
    });

    it('splits a #fragment off the path, the span still the whole link', () => {
        expect(wikiLinkSpans('see [[plans/x.md#phase-1]]')).toEqual([
            { startCol: 4, endCol: 26, path: 'plans/x.md', fragment: 'phase-1' },
        ]);
        expect(wikiLinkSpans('[[a.md # Phase 1 ]]')[0]).toMatchObject({
            path: 'a.md',
            fragment: 'Phase 1',
        });
    });

    it('has no fragment without a #, or with nothing after it', () => {
        expect(wikiLinkSpans('[[a.md]]')[0]).not.toHaveProperty('fragment');
        expect(wikiLinkSpans('[[a.md#]]')[0]).toEqual({ startCol: 0, endCol: 9, path: 'a.md' });
    });

    it('skips a link that is only a fragment — a .tsk file has no headings of its own to name', () => {
        expect(wikiLinkSpans('[[#phase-1]]')).toEqual([]);
    });
});

describe('wikiLinkPrefixAt', () => {
    it('reports the partial path while typing inside [[', () => {
        const line = '- [n] [[notes/20';
        expect(wikiLinkPrefixAt(line, line.length)).toEqual({ startCol: 8, prefix: 'notes/20' });
    });

    it('fires with an empty prefix right after the second [', () => {
        expect(wikiLinkPrefixAt('[[', 2)).toEqual({ startCol: 2, prefix: '' });
    });

    it('stays silent on a single [ — the trigger char fires there too', () => {
        expect(wikiLinkPrefixAt('[', 1)).toBeNull();
        expect(wikiLinkPrefixAt('- [ ] x', 3)).toBeNull();
    });

    it('stays silent once the link is closed', () => {
        const line = '[[a.md]] ';
        expect(wikiLinkPrefixAt(line, line.length)).toBeNull();
    });

    it('uses the LAST open [[ when an earlier link is already closed', () => {
        const line = '[[a.md]] see also [[b';
        expect(wikiLinkPrefixAt(line, line.length)).toEqual({ startCol: 20, prefix: 'b' });
    });

    it('ignores text after the cursor', () => {
        // Cursor between `pl` and `ans`: completing `pl`, not `plans`.
        expect(wikiLinkPrefixAt('[[plans]]', 4)).toEqual({ startCol: 2, prefix: 'pl' });
    });

    it('is null when the cursor sits before the brackets', () => {
        expect(wikiLinkPrefixAt('x [[a', 1)).toBeNull();
    });
});

describe('headingPrefixOf', () => {
    const at = (line: string) => {
        const open = wikiLinkPrefixAt(line, line.length);
        if (open === null) throw new Error(`no open [[ in ${line}`);
        return headingPrefixOf(open);
    };

    it('splits the path from the heading typed so far, which starts after the #', () => {
        expect(at('- [ ] see [[plans/x.md#pha')).toEqual({
            path: 'plans/x.md',
            startCol: 23,
            prefix: 'pha',
        });
    });

    it('starts an empty heading right after the #', () => {
        expect(at('[[x.md#')).toEqual({ path: 'x.md', startCol: 7, prefix: '' });
    });

    it('trims the path, as a link does', () => {
        expect(at('[[ x.md #a')?.path).toBe('x.md');
    });

    it('keeps a later # in the heading, as a link does', () => {
        expect(at('[[x.md#c#-sharp')?.prefix).toBe('c#-sharp');
    });

    it('is undefined before a # — the path is still being typed', () => {
        expect(at('[[plans/x.md')).toBeUndefined();
    });
});

describe('wikiPathCandidates', () => {
    const ROOT = '/work/project';
    const DOC_DIR = '/work/project/apps/app/docs';

    it('tries workspace-relative first, then document-relative', () => {
        expect(wikiPathCandidates('plans/a.md', ROOT, DOC_DIR)).toEqual([
            '/work/project/plans/a.md',
            '/work/project/apps/app/docs/plans/a.md',
        ]);
    });

    it('returns an absolute path alone', () => {
        expect(wikiPathCandidates('/etc/hosts', ROOT, DOC_DIR)).toEqual(['/etc/hosts']);
    });

    it('normalises traversal, and lets it escape the root', () => {
        // `..` is followed, not rejected — same as a markdown link. A link out
        // of the workspace is unusual but not wrong, and refusing it silently
        // would be worse than opening it.
        expect(wikiPathCandidates('../../plans/a.md', ROOT, DOC_DIR)).toEqual([
            '/plans/a.md',
            '/work/project/apps/plans/a.md',
        ]);
    });

    it('de-duplicates when both roots resolve to the same file', () => {
        expect(wikiPathCandidates('a.md', ROOT, ROOT)).toEqual(['/work/project/a.md']);
    });

    it('copes with no workspace folder, and with neither', () => {
        expect(wikiPathCandidates('a.md', undefined, DOC_DIR)).toEqual([
            '/work/project/apps/app/docs/a.md',
        ]);
        expect(wikiPathCandidates('a.md', undefined, undefined)).toEqual([]);
    });
});

describe('buildWikiLinkInsert', () => {
    /** Apply the edit, so each case asserts the resulting LINE, not an offset triple. */
    const apply = (line: string, character: number, relPath: string): string => {
        const e = buildWikiLinkInsert(line, character, relPath);
        return line.slice(0, e.startCol) + e.text + line.slice(e.endCol);
    };

    it('inserts the whole link at a bare cursor', () => {
        expect(apply('- [n] ', 6, 'plans/a.md')).toBe('- [n] [[plans/a.md]]');
    });

    it('completes an unclosed [[ in place', () => {
        expect(apply('- [n] [[pl', 10, 'plans/a.md')).toBe('- [n] [[plans/a.md]]');
    });

    it('does not double the closing brackets when they already exist', () => {
        expect(apply('- [n] [[pl]]', 10, 'plans/a.md')).toBe('- [n] [[plans/a.md]]');
    });

    it('keeps trailing text after the link', () => {
        expect(apply('- [n]  <!-- @id:x -->', 6, 'a.md')).toBe('- [n] [[a.md]] <!-- @id:x -->');
    });

    it('leaves an already-closed link alone and inserts a new one', () => {
        const line = '[[a.md]] ';
        expect(apply(line, line.length, 'b.md')).toBe('[[a.md]] [[b.md]]');
    });
});

describe('danglingWikiLinks', () => {
    const lines = [
        '- [n] good [[a.md]] and [[a.md#there]]',
        '- [n] bad [[missing.md]]',
        '- [n] two bad [[x.md]] and [[a.md#nowhere]]',
        '- [ ] no links here',
    ];
    const problemOf = (span: WikiLinkSpan): WikiLinkProblem | undefined => {
        if (span.path !== 'a.md') return 'no-file';
        return span.fragment === undefined || span.fragment === 'there' ? undefined : 'no-heading';
    };

    it('reports only the unresolvable ones, with exact spans and what is missing', () => {
        expect(danglingWikiLinks(lines, problemOf)).toEqual([
            { line: 1, startCol: 10, endCol: 24, path: 'missing.md', problem: 'no-file' },
            { line: 2, startCol: 14, endCol: 22, path: 'x.md', problem: 'no-file' },
            {
                line: 2,
                startCol: 27,
                endCol: 43,
                path: 'a.md',
                fragment: 'nowhere',
                problem: 'no-heading',
            },
        ]);
    });

    it('the span covers the brackets and nothing else', () => {
        const [first] = danglingWikiLinks([lines[1] as string], problemOf);
        expect((lines[1] as string).slice(first?.startCol, first?.endCol)).toBe('[[missing.md]]');
    });

    it('is empty when everything resolves, and for a file with no links', () => {
        expect(danglingWikiLinks(lines, () => undefined)).toEqual([]);
        expect(danglingWikiLinks(['- [ ] plain'], problemOf)).toEqual([]);
    });
});
