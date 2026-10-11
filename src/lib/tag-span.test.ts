import { describe, expect, it } from 'vitest';
import { findTagDeclarationLine, tagSpanAt } from './tag-span';

describe('tagSpanAt', () => {
    const line = '- [ ] ship it #p/tsk #idea <!-- @id:abc -->';

    it('finds the tag under the cursor, span covering the #', () => {
        const span = tagSpanAt(line, 16); // inside `#p/tsk`
        expect(span).toEqual({ startCol: 14, endCol: 20, tag: 'p/tsk' });
        expect(line.slice(span?.startCol, span?.endCol)).toBe('#p/tsk');
    });

    it('counts the cursor on the # and just past the last letter', () => {
        expect(tagSpanAt(line, 14)?.tag).toBe('p/tsk'); // on the `#`
        expect(tagSpanAt(line, 20)?.tag).toBe('p/tsk'); // just past `k`
    });

    it('picks the tag the cursor is actually on when there are several', () => {
        expect(tagSpanAt(line, 23)?.tag).toBe('idea');
    });

    it('is null off any tag', () => {
        expect(tagSpanAt(line, 0)).toBeNull();
        expect(tagSpanAt(line, 8)).toBeNull(); // inside "ship"
        expect(tagSpanAt(line, 30)).toBeNull(); // inside the metadata comment
    });

    it('ignores a # that is not a tag', () => {
        // Same rule as the parser: a tag needs line-start or whitespace before it.
        expect(tagSpanAt('see issue#42 here', 10)).toBeNull();
        expect(tagSpanAt('- [ ] https://x/y#frag', 19)).toBeNull();
        expect(tagSpanAt('- [ ] #1numeric', 7)).toBeNull(); // must start with a letter
    });

    it('handles a tag at line start and at line end', () => {
        expect(tagSpanAt('#alone', 0)).toEqual({ startCol: 0, endCol: 6, tag: 'alone' });
        expect(tagSpanAt('- [ ] x #end', 12)?.tag).toBe('end');
    });

    it('keeps hyphens and underscores, stops at other punctuation', () => {
        expect(tagSpanAt('- [ ] #a-b_c, rest', 8)?.tag).toBe('a-b_c');
    });
});

describe('findTagDeclarationLine', () => {
    const yaml = [
        '# workspace tags',
        'idea: a thought worth keeping',
        'p/tsk:',
        '  description: the tsk extension',
        "'p/home lab': quoted key",
        'bare:',
    ].join('\n');

    it('finds the string-shorthand form', () => {
        expect(findTagDeclarationLine(yaml, 'idea')).toBe(1);
    });

    it('finds the object form', () => {
        expect(findTagDeclarationLine(yaml, 'p/tsk')).toBe(2);
    });

    it('finds a quoted key', () => {
        expect(findTagDeclarationLine(yaml, 'p/home lab')).toBe(4);
    });

    it('finds a bare entry', () => {
        expect(findTagDeclarationLine(yaml, 'bare')).toBe(5);
    });

    it('is null for an undeclared tag', () => {
        expect(findTagDeclarationLine(yaml, 'nope')).toBeNull();
        expect(findTagDeclarationLine('', 'idea')).toBeNull();
    });

    it('also matches an indented (nested) key of the same name — an accepted limitation', () => {
        // `description:` is nested under p/tsk — a tag called "description"
        // would otherwise resolve to someone else's field. Indented keys do
        // match by design (a tag line may be indented), so this documents the
        // accepted limitation rather than a guarantee.
        expect(findTagDeclarationLine(yaml, 'description')).toBe(3);
    });

    it('is not fooled by a prefix of another tag', () => {
        expect(findTagDeclarationLine('ideas: plural\n', 'idea')).toBeNull();
    });
});
