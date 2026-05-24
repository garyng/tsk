import { describe, expect, it } from 'vitest';
import { type Marker, parseLine } from './parser';

describe('parseLine — non-task lines', () => {
    it.each([
        ['empty', ''],
        ['plain text', 'hello world'],
        ['markdown heading', '# heading'],
        ['plain bullet without marker', '- regular bullet'],
        ['unknown marker char', '- [y] unknown'],
        ['marker without bullet', '[x] no bullet'],
        ['empty brackets', '- [] foo'],
        ['multiple chars in brackets', '- [xx] foo'],
        ['bullet without space before marker', '-[x] foo'],
    ])('returns null for %s', (_label, line) => {
        expect(parseLine(line)).toBeNull();
    });
});

describe('parseLine — markers', () => {
    it.each<[string, Marker]>([
        [' ', 'todo'],
        ['/', 'inprogress'],
        ['x', 'completed'],
        ['X', 'completed'],
        ['>', 'moved'],
        ['!', 'cancelled'],
        ['n', 'notes'],
        ['N', 'notes'],
    ])('canonicalizes [%s] to %s', (ch, expected) => {
        expect(parseLine(`- [${ch}] task`)?.marker).toBe(expected);
    });

    it('accepts * and + as bullet chars', () => {
        expect(parseLine('* [x] task')?.marker).toBe('completed');
        expect(parseLine('+ [x] task')?.marker).toBe('completed');
    });
});

describe('parseLine — indent', () => {
    it.each([
        ['', '- [x] task'],
        ['    ', '    - [x] task'],
        ['\t', '\t- [x] task'],
        ['  \t', '  \t- [x] task'],
        ['        ', '        - [x] task'],
    ])('captures indent %j', (expected, line) => {
        expect(parseLine(line)?.indent).toBe(expected);
    });
});

describe('parseLine — content', () => {
    it('captures plain content', () => {
        expect(parseLine('- [x] do thing')?.content).toBe('do thing');
    });

    it('keeps tags in content', () => {
        expect(parseLine('- [x] do #tag thing')?.content).toBe('do #tag thing');
    });

    it('strips metadata comments from content', () => {
        expect(parseLine('- [x] do thing <!-- @id:abc -->')?.content).toBe('do thing');
    });

    it('handles empty content (no trailing chars)', () => {
        expect(parseLine('- [x]')?.content).toBe('');
        expect(parseLine('- [x] ')?.content).toBe('');
    });

    it('handles content composed only of metadata', () => {
        expect(parseLine('- [x] <!-- @id:abc -->')?.content).toBe('');
    });

    it('preserves inline markdown formatting in content', () => {
        expect(parseLine('- [x] **bold** and `code`')?.content).toBe('**bold** and `code`');
    });

    it('strips multiple comment blocks', () => {
        expect(parseLine('- [x] a <!-- @a:1 --> b <!-- @b:2 -->')?.content).toBe('a  b');
    });
});

describe('parseLine — metadata', () => {
    it('extracts a single @key:value pair', () => {
        const t = parseLine('- [x] do <!-- @id:abc12345 -->');
        expect(t?.metadata.get('id')).toBe('abc12345');
    });

    it('extracts multiple entries from one comment', () => {
        const t = parseLine('- [x] do <!-- @id:abc @created:2026-01-02T12:45:30+08:00 -->');
        expect(t?.metadata.get('id')).toBe('abc');
        expect(t?.metadata.get('created')).toBe('2026-01-02T12:45:30+08:00');
    });

    it('preserves insertion order across keys', () => {
        const t = parseLine('- [x] do <!-- @b:2 @a:1 @c:3 -->');
        expect([...(t?.metadata.keys() ?? [])]).toEqual(['b', 'a', 'c']);
    });

    it('distinguishes value-less @flag from @flag: (empty value)', () => {
        const t1 = parseLine('- [x] do <!-- @flag -->');
        const t2 = parseLine('- [x] do <!-- @flag: -->');
        expect(t1?.metadata.get('flag')).toBeNull();
        expect(t2?.metadata.get('flag')).toBe('');
    });

    it('accumulates entries across separate comment blocks', () => {
        const t = parseLine('- [x] a <!-- @a:1 --> b <!-- @b:2 -->');
        expect(t?.metadata.get('a')).toBe('1');
        expect(t?.metadata.get('b')).toBe('2');
    });

    it('handles comments without surrounding whitespace', () => {
        const t = parseLine('- [x] do<!--@id:abc-->');
        expect(t?.metadata.get('id')).toBe('abc');
    });

    it('returns empty Map when no metadata comment is present', () => {
        const t = parseLine('- [x] plain task');
        expect(t?.metadata.size).toBe(0);
    });

    it('ignores non-@-prefixed text inside the comment', () => {
        const t = parseLine('- [x] do <!-- not metadata here -->');
        expect(t?.metadata.size).toBe(0);
    });
});

describe('parseLine — tags', () => {
    it('extracts a single tag', () => {
        expect(parseLine('- [x] do #tag1 thing')?.tags).toEqual(['tag1']);
    });

    it('extracts multiple tags in order', () => {
        expect(parseLine('- [x] do #a #b #c')?.tags).toEqual(['a', 'b', 'c']);
    });

    it('extracts a hierarchical tag', () => {
        expect(parseLine('- [x] do #project/test/sub')?.tags).toEqual(['project/test/sub']);
    });

    it('does not match # at the end of a word', () => {
        expect(parseLine('- [x] foo#bar')?.tags).toEqual([]);
    });

    it('returns an empty array when no tags are present', () => {
        expect(parseLine('- [x] plain task')?.tags).toEqual([]);
    });

    it('does not surface tags from inside a stripped metadata comment', () => {
        expect(parseLine('- [x] thing <!-- @tags:foo #bar -->')?.tags).toEqual([]);
    });

    it('handles a tag at the very start of content', () => {
        expect(parseLine('- [x] #leadtag rest')?.tags).toEqual(['leadtag']);
    });
});
