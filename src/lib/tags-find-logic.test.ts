import { describe, expect, it } from 'vitest';
import type { TagDef } from './tags-config';
import { buildFindInFilesArgs, tagsToPickItems } from './tags-find-logic';

describe('tagsToPickItems', () => {
    it('returns an empty array for an empty map', () => {
        expect(tagsToPickItems(new Map())).toEqual([]);
    });

    it('omits `description` when the tag has no yaml description', () => {
        const map = new Map<string, TagDef>([['project/tsk', {}]]);
        expect(tagsToPickItems(map)).toEqual([{ label: 'project/tsk' }]);
    });

    it('includes `description` when the yaml provided one', () => {
        const map = new Map<string, TagDef>([
            ['project/tsk', { description: 'the tsk extension', parent: 'project' }],
        ]);
        expect(tagsToPickItems(map)).toEqual([
            { label: 'project/tsk', description: 'the tsk extension' },
        ]);
    });

    it('preserves the map iteration order', () => {
        const map = new Map<string, TagDef>([
            ['zeta', { description: 'z' }],
            ['alpha', {}],
            ['mu', { description: 'm' }],
        ]);
        expect(tagsToPickItems(map).map((i) => i.label)).toEqual(['zeta', 'alpha', 'mu']);
    });

    it('drops `parent` from the QuickPick row (it has no surface in the picker)', () => {
        const map = new Map<string, TagDef>([['child', { parent: 'parent' }]]);
        const items = tagsToPickItems(map);
        expect(items).toHaveLength(1);
        expect(items[0]).not.toHaveProperty('parent');
    });
});

describe('buildFindInFilesArgs', () => {
    it('prefixes the query with `#` and scopes to *.tsk', () => {
        expect(buildFindInFilesArgs('project/tsk')).toEqual({
            query: '#project/tsk',
            filesToInclude: '*.tsk',
            triggerSearch: true,
        });
    });

    it('passes tag names with hyphens / digits through unchanged', () => {
        expect(buildFindInFilesArgs('JIRAID-123').query).toBe('#JIRAID-123');
    });
});
