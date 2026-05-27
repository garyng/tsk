import { describe, expect, it } from 'vitest';
import { findTagPrefixContext } from './tags-completion-logic';

describe('findTagPrefixContext', () => {
    it('returns context immediately after a `#` at start of line', () => {
        // "#|"
        expect(findTagPrefixContext('#', 1)).toEqual({ startCol: 1, endCol: 1, partial: '' });
    });

    it('returns context after a `#` preceded by whitespace', () => {
        // "  #|"
        expect(findTagPrefixContext('  #', 3)).toEqual({ startCol: 3, endCol: 3, partial: '' });
    });

    it('returns the partial substring between `#` and cursor', () => {
        // "#proj|"
        expect(findTagPrefixContext('#proj', 5)).toEqual({
            startCol: 1,
            endCol: 5,
            partial: 'proj',
        });
    });

    it('extends endCol past the cursor when mid-word', () => {
        // "#proj|ect"
        expect(findTagPrefixContext('#project', 5)).toEqual({
            startCol: 1,
            endCol: 8,
            partial: 'proj',
        });
    });

    it('handles slashes and dashes in the partial', () => {
        expect(findTagPrefixContext('#project/tsk', 12)?.partial).toBe('project/tsk');
        expect(findTagPrefixContext('#JIRAID-123', 11)?.partial).toBe('JIRAID-123');
    });

    it('returns undefined when the cursor is not in a tag context', () => {
        expect(findTagPrefixContext('hello world', 5)).toBeUndefined();
        expect(findTagPrefixContext('plain text', 10)).toBeUndefined();
    });

    it('returns undefined for a markdown heading (`# heading|`)', () => {
        // The `#` is followed by a space, so by the time we walk back
        // past `heading` we land on the space, not the `#`.
        expect(findTagPrefixContext('# heading', 9)).toBeUndefined();
    });

    it('returns undefined inside consecutive `#`s like `###heading|`', () => {
        // The closest `#` is preceded by another `#`, not whitespace — so
        // this is markdown-heading syntax, not a tag.
        expect(findTagPrefixContext('###heading', 10)).toBeUndefined();
    });

    it('triggers for inline tags after whitespace mid-line', () => {
        // "do thing #proj|"
        expect(findTagPrefixContext('do thing #proj', 14)).toEqual({
            startCol: 10,
            endCol: 14,
            partial: 'proj',
        });
    });

    it('does NOT trigger when `#` is preceded by a non-whitespace character', () => {
        // "abc#tag|" — the `#` is inline with no whitespace gap.
        expect(findTagPrefixContext('abc#tag', 7)).toBeUndefined();
    });
});
