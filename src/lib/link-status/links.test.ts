import { describe, expect, it } from 'vitest';
import { parseAutoLinkRules } from '../autolinks';
import { findLinks } from './links';

const jira = parseAutoLinkRules([
    { pattern: '([A-Z]+)-([0-9]+)', target: 'https://jira.example.com/browse/$1-$2' },
]).rules;
const urls = (text: string) =>
    findLinks(text, jira).map((l) => [text.slice(l.startCol, l.endCol), l.url]);

describe('findLinks', () => {
    it('finds bare URLs, without the punctuation after them', () => {
        expect(urls('see https://github.com/o/r/pull/12. and (https://x.example/a)')).toEqual([
            ['https://github.com/o/r/pull/12', 'https://github.com/o/r/pull/12'],
            ['https://x.example/a', 'https://x.example/a'],
        ]);
    });

    it('ends a URL at Unicode punctuation, and keeps parentheses that pair in its path', () => {
        expect(
            urls('“https://x.example/a”, https://x.example/b，then https://x.example/c…'),
        ).toEqual([
            ['https://x.example/a', 'https://x.example/a'],
            ['https://x.example/b', 'https://x.example/b'],
            ['https://x.example/c', 'https://x.example/c'],
        ]);
        expect(urls('see https://en.wikipedia.org/wiki/Foo_(bar) ok')).toEqual([
            ['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
        ]);
    });

    it('takes a Markdown link whole, its text included, and not the URL in it again', () => {
        expect(
            urls('- [the PR](https://github.com/o/r/pull/12) and [t](<https://a.example/b> "T")'),
        ).toEqual([
            ['[the PR](https://github.com/o/r/pull/12)', 'https://github.com/o/r/pull/12'],
            ['[t](<https://a.example/b> "T")', 'https://a.example/b'],
        ]);
    });

    it('takes autolinks by their target, but not one inside a URL', () => {
        expect(urls('ABC-12, and https://jira.example.com/browse/ABC-34')).toEqual([
            ['ABC-12', 'https://jira.example.com/browse/ABC-12'],
            ['https://jira.example.com/browse/ABC-34', 'https://jira.example.com/browse/ABC-34'],
        ]);
    });

    it('leaves out what has no web scheme: emails, fuzzy hosts, ftp, a wiki link', () => {
        expect(
            urls('me@x.example, x.example, ftp://x.example/f, [[plans/a.md]], [a](plans/a.md)'),
        ).toEqual([]);
    });

    it('leaves out an autolink whose target is no web URL', () => {
        const local = parseAutoLinkRules([{ pattern: 'T-([0-9]+)', target: 'tickets/$1' }]).rules;
        expect(findLinks('T-1', local)).toEqual([]);
    });
});
