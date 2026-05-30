import { describe, expect, it } from 'vitest';
import type { TagDef } from './tags-config';
import { buildSearchEditorArgs, countTasksByTag, tagsToPickItems } from './tags-find-logic';

const NO_COUNTS = new Map<string, number>();

describe('tagsToPickItems', () => {
    it('returns an empty array for an empty map', () => {
        expect(tagsToPickItems(new Map(), NO_COUNTS)).toEqual([]);
    });

    it('renders `0 tasks` when a tag has no count and no description', () => {
        const map = new Map<string, TagDef>([['project/tsk', {}]]);
        expect(tagsToPickItems(map, NO_COUNTS)).toEqual([
            { label: 'project/tsk', description: '0 tasks' },
        ]);
    });

    it('renders count + description joined by `·` when both exist', () => {
        const map = new Map<string, TagDef>([
            ['project/tsk', { description: 'the tsk extension', parent: 'project' }],
        ]);
        const counts = new Map([['project/tsk', 5]]);
        expect(tagsToPickItems(map, counts)).toEqual([
            { label: 'project/tsk', description: '5 tasks · the tsk extension' },
        ]);
    });

    it('pluralises the count label (1 task vs N tasks)', () => {
        const map = new Map<string, TagDef>([
            ['singular', {}],
            ['plural', {}],
        ]);
        const counts = new Map([
            ['singular', 1],
            ['plural', 3],
        ]);
        const items = tagsToPickItems(map, counts);
        expect(items[0]?.description).toBe('1 task');
        expect(items[1]?.description).toBe('3 tasks');
    });

    it('renders `0 tasks · <desc>` for a yaml tag carried by no task', () => {
        // Decision: keep zero-count tags in the list (don't drop them) so
        // the user sees the tag exists but is currently empty.
        const map = new Map<string, TagDef>([['planned', { description: 'not started yet' }]]);
        expect(tagsToPickItems(map, NO_COUNTS)).toEqual([
            { label: 'planned', description: '0 tasks · not started yet' },
        ]);
    });

    it('preserves the map iteration order', () => {
        const map = new Map<string, TagDef>([
            ['zeta', { description: 'z' }],
            ['alpha', {}],
            ['mu', { description: 'm' }],
        ]);
        expect(tagsToPickItems(map, NO_COUNTS).map((i) => i.label)).toEqual([
            'zeta',
            'alpha',
            'mu',
        ]);
    });

    it('drops `parent` from the QuickPick row (it has no surface in the picker)', () => {
        const map = new Map<string, TagDef>([['child', { parent: 'parent' }]]);
        const items = tagsToPickItems(map, NO_COUNTS);
        expect(items).toHaveLength(1);
        expect(items[0]).not.toHaveProperty('parent');
    });
});

describe('countTasksByTag', () => {
    it('returns an empty map for no pairs', () => {
        expect(countTasksByTag([])).toEqual(new Map());
    });

    it('counts a single task tagged with a flat tag', () => {
        const counts = countTasksByTag([['t1', 'urgent']]);
        expect(counts.get('urgent')).toBe(1);
    });

    it('counts a hierarchical tag toward its implicit parents too', () => {
        // One task tagged #project/tsk counts toward both `project/tsk`
        // AND its implicit parent `project`.
        const counts = countTasksByTag([['t1', 'project/tsk']]);
        expect(counts.get('project/tsk')).toBe(1);
        expect(counts.get('project')).toBe(1);
    });

    it('dedupes a task that carries both a parent and child tag', () => {
        // t1 has #project AND #project/tsk explicitly. It should count
        // ONCE toward `project` (not twice), and once toward `project/tsk`.
        const counts = countTasksByTag([
            ['t1', 'project'],
            ['t1', 'project/tsk'],
        ]);
        expect(counts.get('project')).toBe(1);
        expect(counts.get('project/tsk')).toBe(1);
    });

    it('aggregates distinct tasks under a shared parent', () => {
        // Two different tasks under #project via different children.
        const counts = countTasksByTag([
            ['t1', 'project/tsk'],
            ['t2', 'project/docs'],
        ]);
        expect(counts.get('project')).toBe(2);
        expect(counts.get('project/tsk')).toBe(1);
        expect(counts.get('project/docs')).toBe(1);
    });

    it('counts the same tag on distinct tasks once each', () => {
        const counts = countTasksByTag([
            ['t1', 'urgent'],
            ['t2', 'urgent'],
            ['t2', 'urgent'],
        ]);
        // t2's duplicate pair (shouldn't happen in practice) is deduped.
        expect(counts.get('urgent')).toBe(2);
    });
});

describe('buildSearchEditorArgs', () => {
    it('prefixes the query with `#`, scopes to *.tsk, and sets the search-editor flags', () => {
        expect(buildSearchEditorArgs('project/tsk')).toEqual({
            query: '#project/tsk',
            filesToInclude: '*.tsk',
            isRegexp: false,
            triggerSearch: true,
            focusResults: true,
            showIncludesExcludes: true,
            contextLines: 0,
        });
    });

    it('passes tag names with hyphens / digits through unchanged', () => {
        expect(buildSearchEditorArgs('JIRAID-123').query).toBe('#JIRAID-123');
    });

    it('never enables regex (substring semantics are intentional)', () => {
        expect(buildSearchEditorArgs('project').isRegexp).toBe(false);
    });

    it('defaults to 0 context lines (just the matching task rows)', () => {
        expect(buildSearchEditorArgs('project').contextLines).toBe(0);
    });
});
