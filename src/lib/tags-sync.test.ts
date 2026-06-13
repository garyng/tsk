import { describe, expect, it } from 'vitest';
import { parseTagsYaml } from './tags-config';
import { buildTagsAppendText, computeMissingTags } from './tags-sync';

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
