import { describe, expect, it } from 'vitest';
import { parseTagsYaml } from './tags-config';
import { buildTagEntryText, buildTagsAppendText, computeMissingTags, yamlKey } from './tags-sync';

const TODAY = '2026-06-13';

describe('computeMissingTags', () => {
    it('returns discovered-minus-declared, sorted', () => {
        expect(
            computeMissingTags(['urgent', 'project/web', 'project/tsk'], ['project/tsk']),
        ).toEqual(['project/web', 'urgent']);
    });

    it('is empty when everything discovered is already declared', () => {
        expect(computeMissingTags(['a', 'b'], ['b', 'a', 'c'])).toEqual([]);
    });

    it('de-duplicates discovered and skips empty strings', () => {
        expect(computeMissingTags(['dup', 'dup', '', 'x'], [])).toEqual(['dup', 'x']);
    });

    it('ignores declared tags that no task carries (one-directional diff)', () => {
        expect(computeMissingTags(['used'], ['declared-only', 'used'])).toEqual([]);
    });
});

describe('buildTagsAppendText', () => {
    it('returns "" when nothing is missing (caller writes nothing)', () => {
        expect(buildTagsAppendText('foo: bar\n', [], TODAY, '\n')).toBe('');
    });

    it('a new file (empty existing) gets the block alone, no leading blank line', () => {
        expect(buildTagsAppendText('', ['b', 'a'], TODAY, '\n')).toBe(
            `# discovered ${TODAY} — fill in description / parent\nb:\na:\n`,
        );
    });

    it('an existing file ending in a newline gets one blank line before the header', () => {
        expect(buildTagsAppendText('existing: x\n', ['new'], TODAY, '\n')).toBe(
            `\n# discovered ${TODAY} — fill in description / parent\nnew:\n`,
        );
    });

    it('an existing file WITHOUT a trailing newline gets the newline plus a blank line', () => {
        expect(buildTagsAppendText('existing: x', ['new'], TODAY, '\n')).toBe(
            `\n\n# discovered ${TODAY} — fill in description / parent\nnew:\n`,
        );
    });

    it('honors a CRLF eol throughout', () => {
        expect(buildTagsAppendText('existing: x\r\n', ['new'], TODAY, '\r\n')).toBe(
            `\r\n# discovered ${TODAY} — fill in description / parent\r\nnew:\r\n`,
        );
    });

    it('preserves the caller-supplied entry order (already sorted upstream)', () => {
        const out = buildTagsAppendText('', ['a', 'b/c', 'JIRAID-9'], TODAY, '\n');
        expect(out.split('\n').filter((l) => l.endsWith(':'))).toEqual(['a:', 'b/c:', 'JIRAID-9:']);
    });
});

describe('round-trip through parseTagsYaml (output is valid yaml)', () => {
    it('new-file output re-parses to exactly the stub tags as bare defs', () => {
        const missing = ['urgent', 'project/web', 'JIRAID-123', 'milestone/M9'];
        const parsed = parseTagsYaml(buildTagsAppendText('', missing, TODAY, '\n'));
        expect([...parsed.keys()].sort()).toEqual([...missing].sort());
        expect([...parsed.values()]).toEqual(missing.map(() => ({})));
    });

    it('appended output re-parses to the union of existing + new keys', () => {
        const existing =
            'project/tsk:\n    description: The tsk extension itself\nmilestone/M2: Parser milestone\n';
        const full = existing + buildTagsAppendText(existing, ['urgent'], TODAY, '\n');
        const parsed = parseTagsYaml(full);
        expect([...parsed.keys()].sort()).toEqual(['milestone/M2', 'project/tsk', 'urgent']);
        expect(parsed.get('project/tsk')).toEqual({ description: 'The tsk extension itself' });
        expect(parsed.get('urgent')).toEqual({});
    });
});

describe('buildTagEntryText', () => {
    it('writes the string-shorthand form, quoted', () => {
        expect(buildTagEntryText('idea: x\n', 'p/tsk', 'the tsk extension', '\n')).toBe(
            'p/tsk: "the tsk extension"\n',
        );
    });

    it('adds a separator when the file lacks a trailing newline, none for an empty file', () => {
        expect(buildTagEntryText('idea: x', 'new', 'd', '\n')).toBe('\nnew: "d"\n');
        expect(buildTagEntryText('', 'new', 'd', '\n')).toBe('new: "d"\n');
    });

    it('survives a description YAML would otherwise choke on', () => {
        for (const description of [
            'has: a colon',
            '# starts like a comment',
            '- starts like a list',
            '{flow: mapping}',
            'ends with a backslash \\',
            'has "quotes" inside',
            '',
        ]) {
            const text = buildTagEntryText('', 'tag', description, '\n');
            const parsed = parseTagsYaml(text);
            expect(parsed.get('tag')?.description, `failed on ${JSON.stringify(description)}`).toBe(
                description === '' ? undefined : description,
            );
        }
    });
});

describe('yamlKey — tags that YAML would reinterpret', () => {
    // Every one of these is a legal tag (`#[A-Za-z][A-Za-z0-9_/-]*`).
    const KEYWORDS = ['null', 'Null', 'NULL', 'true', 'True', 'FALSE'];

    it('leaves ordinary tags bare', () => {
        expect(yamlKey('idea')).toBe('idea');
        expect(yamlKey('p/tsk')).toBe('p/tsk');
        expect(yamlKey('a-b_c')).toBe('a-b_c');
    });

    it('quotes exactly the keywords that would not re-parse as themselves', () => {
        for (const tag of ['null', 'Null', 'NULL', 'True', 'FALSE']) {
            expect(yamlKey(tag)).toBe(JSON.stringify(tag));
        }
        // Lowercase `true` parses as a boolean key, which stringifies straight
        // back to "true" — the same tag, so it needs no quotes. This is why the
        // parser decides rather than a keyword list: a list would quote it.
        expect(yamlKey('true')).toBe('true');
    });

    it('Define Tag: a keyword tag survives the round trip', () => {
        // Unquoted, `null:` re-parsed as an empty key that parseTagsYaml drops,
        // and `True:` as `true` — the declaration was silently lost.
        for (const tag of KEYWORDS) {
            const parsed = parseTagsYaml(buildTagEntryText('', tag, 'desc', '\n'));
            expect([...parsed.keys()], tag).toEqual([tag]);
            expect(parsed.get(tag)?.description).toBe('desc');
        }
    });

    it('Add Discovered Tags: keyword tags survive the round trip', () => {
        const parsed = parseTagsYaml(buildTagsAppendText('', KEYWORDS, TODAY, '\n'));
        expect([...parsed.keys()].sort()).toEqual([...KEYWORDS].sort());
    });
});
