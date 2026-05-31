import { describe, expect, it } from 'vitest';
import { expandImplicitParents, mergeTagDefs, parseTagsYaml, type TagDef } from './tags-config';

describe('parseTagsYaml', () => {
    it('returns an empty map for empty / whitespace / comment-only input', () => {
        expect(parseTagsYaml('').size).toBe(0);
        expect(parseTagsYaml('   \n\n  ').size).toBe(0);
        expect(parseTagsYaml('# only comments\n# nothing here').size).toBe(0);
    });

    it('returns an empty map for malformed yaml', () => {
        // Stray `:` in flow-style — yaml.parse throws.
        expect(parseTagsYaml('{:').size).toBe(0);
    });

    it('returns an empty map when the doc parses to a non-object', () => {
        expect(parseTagsYaml('just a scalar').size).toBe(0);
        expect(parseTagsYaml('- a\n- b\n').size).toBe(0);
        expect(parseTagsYaml('42').size).toBe(0);
    });

    it('treats string values as the description shorthand', () => {
        const map = parseTagsYaml(['foo: lorem ipsum', 'bar: another'].join('\n'));
        expect(map.get('foo')).toEqual({ description: 'lorem ipsum' });
        expect(map.get('bar')).toEqual({ description: 'another' });
    });

    it('treats null / empty / explicit-empty-object values as bare {}', () => {
        const map = parseTagsYaml(['foo:', 'bar: ""', 'baz: {}'].join('\n'));
        expect(map.get('foo')).toEqual({});
        expect(map.get('bar')).toEqual({});
        expect(map.get('baz')).toEqual({});
    });

    it('extracts description + parent from the object form', () => {
        const map = parseTagsYaml(
            ['project/tsk:', '    description: the tsk extension', '    parent: project'].join(
                '\n',
            ),
        );
        expect(map.get('project/tsk')).toEqual({
            description: 'the tsk extension',
            parent: 'project',
        });
    });

    it('drops non-string description / parent fields from the object form', () => {
        const map = parseTagsYaml(
            [
                'a:',
                '    description: 42',
                '    parent: ["nope"]',
                'b:',
                '    description: ok',
                '    parent: 5',
            ].join('\n'),
        );
        expect(map.get('a')).toEqual({});
        expect(map.get('b')).toEqual({ description: 'ok' });
    });

    it('skips entries whose value is a number, boolean, or array', () => {
        const map = parseTagsYaml(
            ['skipnum: 5', 'skipbool: true', 'skiparr:', '    - a', '    - b'].join('\n'),
        );
        expect(map.has('skipnum')).toBe(false);
        expect(map.has('skipbool')).toBe(false);
        expect(map.has('skiparr')).toBe(false);
    });

    it('mixes string-form and object-form entries in a single document', () => {
        const map = parseTagsYaml(
            [
                'project/tsk: the tsk extension',
                'milestone/M8:',
                '    description: tags milestone',
                '    parent: milestone',
            ].join('\n'),
        );
        expect(map.get('project/tsk')).toEqual({ description: 'the tsk extension' });
        expect(map.get('milestone/M8')).toEqual({
            description: 'tags milestone',
            parent: 'milestone',
        });
    });

    it('preserves document insertion order', () => {
        const map = parseTagsYaml(['zeta: z', 'alpha: a', 'mu: m'].join('\n'));
        expect([...map.keys()]).toEqual(['zeta', 'alpha', 'mu']);
    });
});

describe('expandImplicitParents', () => {
    it('returns the set of inputs unchanged when no separators are present', () => {
        expect(expandImplicitParents(['a', 'b', 'c'])).toEqual(new Set(['a', 'b', 'c']));
    });

    it('adds the single implicit parent for a one-slash tag', () => {
        expect(expandImplicitParents(['project/tsk'])).toEqual(new Set(['project', 'project/tsk']));
    });

    it('adds every implicit prefix for a multi-slash tag', () => {
        expect(expandImplicitParents(['inventory/homelab/nas1'])).toEqual(
            new Set(['inventory', 'inventory/homelab', 'inventory/homelab/nas1']),
        );
    });

    it('dedupes overlapping prefixes across inputs', () => {
        expect(expandImplicitParents(['project/tsk', 'project/homelab', 'project'])).toEqual(
            new Set(['project', 'project/tsk', 'project/homelab']),
        );
    });

    it('ignores empty strings in the input', () => {
        expect(expandImplicitParents(['', 'a/b'])).toEqual(new Set(['a', 'a/b']));
    });

    it('returns an empty set for an empty iterable', () => {
        expect(expandImplicitParents([])).toEqual(new Set());
    });
});

describe('mergeTagDefs', () => {
    it('returns yaml entries verbatim when no tags are discovered', () => {
        const yaml = new Map<string, TagDef>([['project/tsk', { description: 'extension' }]]);
        const merged = mergeTagDefs(yaml, []);
        expect([...merged.entries()]).toEqual([['project/tsk', { description: 'extension' }]]);
    });

    it('adds discovered tags with empty defs when not present in yaml', () => {
        const merged = mergeTagDefs(new Map(), ['JIRAID-123', 'project/test']);
        expect(merged.get('JIRAID-123')).toEqual({});
        expect(merged.get('project')).toEqual({});
        expect(merged.get('project/test')).toEqual({});
    });

    it('preserves yaml description for tags that are also discovered', () => {
        const yaml = new Map<string, TagDef>([
            ['project/tsk', { description: 'extension', parent: 'project' }],
        ]);
        const merged = mergeTagDefs(yaml, ['project/tsk']);
        expect(merged.get('project/tsk')).toEqual({
            description: 'extension',
            parent: 'project',
        });
    });

    it('expands implicit parents from discovered tags as empty defs', () => {
        const merged = mergeTagDefs(new Map(), ['inventory/homelab/nas1']);
        expect([...merged.keys()].sort()).toEqual([
            'inventory',
            'inventory/homelab',
            'inventory/homelab/nas1',
        ]);
        expect(merged.get('inventory')).toEqual({});
        expect(merged.get('inventory/homelab')).toEqual({});
    });

    it('places yaml entries before discovered-only entries in iteration order', () => {
        const yaml = new Map<string, TagDef>([
            ['declared', { description: 'first' }],
            ['project', { description: 'second' }],
        ]);
        const merged = mergeTagDefs(yaml, ['project/tsk', 'JIRAID-123']);
        expect([...merged.keys()]).toEqual(['declared', 'project', 'project/tsk', 'JIRAID-123']);
    });
});
