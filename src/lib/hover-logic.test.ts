import { describe, expect, it } from 'vitest';
import type { TaskRecord } from './db';
import type { GraphNode } from './graph';
import { buildTaskHoverMarkdown, type HoverDeps, type HoverTaskInput } from './hover-logic';

const makeTask = (overrides: Partial<HoverTaskInput> = {}): HoverTaskInput => ({
    marker: 'todo',
    metadata: new Map<string, string | null>(),
    tags: [],
    fileUri: 'file:///work/notes.tsk',
    line: 0,
    ...overrides,
});

const FIXED_NOW = new Date('2026-05-27T12:00:00+08:00');

const emptyDeps: HoverDeps = {
    lookupTask: () => undefined,
    lookupGraph: () => undefined,
    lookupTagDescription: () => undefined,
    now: () => FIXED_NOW,
};

const makeRecord = (id: string, content: string): TaskRecord => ({
    id,
    fileUri: 'file:///work/other.tsk',
    line: 5,
    marker: 'todo',
    content,
    raw: `- [ ] ${content} <!-- @id:${id} -->`,
});

describe('buildTaskHoverMarkdown', () => {
    it('renders only the marker status label in the header (no content duplication)', () => {
        // The task's content is already on the source line under the cursor;
        // re-printing it in the hover adds noise. Each marker maps to a
        // human-readable status word ("Todo" / "In Progress" / etc).
        expect(buildTaskHoverMarkdown(makeTask({ marker: 'todo' }), emptyDeps)).toMatch(
            /^\*\*Todo\*\*/,
        );
        expect(buildTaskHoverMarkdown(makeTask({ marker: 'inprogress' }), emptyDeps)).toMatch(
            /^\*\*In Progress\*\*/,
        );
        expect(buildTaskHoverMarkdown(makeTask({ marker: 'completed' }), emptyDeps)).toMatch(
            /^\*\*Completed\*\*/,
        );
        expect(buildTaskHoverMarkdown(makeTask({ marker: 'notes' }), emptyDeps)).toMatch(
            /^\*\*Note\*\*/,
        );
    });

    it('renders @id and @priority in the metadata table', () => {
        const md = buildTaskHoverMarkdown(
            makeTask({
                metadata: new Map([
                    ['id', 'abc123'],
                    ['priority', '1'],
                ]),
            }),
            emptyDeps,
        );
        expect(md).toContain('| id | `abc123` |');
        expect(md).toContain('| priority | P1 |');
    });

    it('annotates timestamp metadata with a human-friendly relative distance', () => {
        // FIXED_NOW = 2026-05-27T12:00:00+08:00.
        // @created at 2026-05-27T10:00:00+08:00 is 2 hours before.
        const md = buildTaskHoverMarkdown(
            makeTask({
                metadata: new Map([
                    ['created', '2026-05-27T10:00:00+08:00'],
                    ['completed', '2026-05-25T12:00:00+08:00'],
                ]),
            }),
            emptyDeps,
        );
        expect(md).toContain('| created | 2026-05-27T10:00:00+08:00 (about 2 hours ago) |');
        expect(md).toContain('| completed | 2026-05-25T12:00:00+08:00 (2 days ago) |');
    });

    it('falls back to the raw value when a timestamp string is unparseable', () => {
        const md = buildTaskHoverMarkdown(
            makeTask({
                metadata: new Map([['created', 'not-a-date']]),
            }),
            emptyDeps,
        );
        expect(md).toContain('| created | not-a-date |');
    });

    it('omits the metadata table entirely when no rows would be shown', () => {
        const md = buildTaskHoverMarkdown(makeTask({ metadata: new Map() }), emptyDeps);
        expect(md).not.toContain('|--|--|');
    });

    it('renders tags with their yaml description when available', () => {
        const md = buildTaskHoverMarkdown(makeTask({ tags: ['project/tsk', 'milestone/M3'] }), {
            ...emptyDeps,
            lookupTagDescription: (tag) =>
                tag === 'project/tsk' ? 'Self-hosted tsk extension' : undefined,
        });
        expect(md).toContain('`#project/tsk` *(Self\\-hosted tsk extension)*');
        expect(md).toContain('`#milestone/M3`');
        // No description for milestone/M3.
        expect(md).not.toContain('milestone/M3`*');
    });

    it('renders a forward parent ref as a clickable command link when the target exists', () => {
        const md = buildTaskHoverMarkdown(makeTask({ metadata: new Map([['parent', 'p1']]) }), {
            ...emptyDeps,
            lookupTask: (id) => (id === 'p1' ? makeRecord('p1', 'the parent') : undefined),
        });
        expect(md).toContain('**parent:** [the parent](command:tsk.goToParent?');
        expect(md).toContain(encodeURIComponent('["p1"]'));
        expect(md).toContain('`(p1)`');
    });

    it('marks a missing parent as `missing in workspace`', () => {
        const md = buildTaskHoverMarkdown(
            makeTask({ metadata: new Map([['parent', 'gone']]) }),
            emptyDeps,
        );
        expect(md).toContain('**parent:** `(gone)` *— missing in workspace*');
        expect(md).not.toContain('command:tsk.goToParent');
    });

    it('renders inverse children with count + links when the graph node has children', () => {
        const node: GraphNode = {
            id: 'parent-1',
            fileUri: 'file:///work/notes.tsk',
            line: 0,
            forward: {},
            inverse: { children: ['c1', 'c2'], dependents: [], related: [] },
        };
        const md = buildTaskHoverMarkdown(makeTask({ metadata: new Map([['id', 'parent-1']]) }), {
            ...emptyDeps,
            lookupGraph: (id) => (id === 'parent-1' ? node : undefined),
            lookupTask: (id) => makeRecord(id, `child ${id}`),
        });
        expect(md).toContain('**children (2):**');
        expect(md).toContain('[child c1](command:tsk.goToParent?');
        expect(md).toContain('[child c2](command:tsk.goToParent?');
    });

    it('omits inverse sections when there are no edges in that direction', () => {
        const node: GraphNode = {
            id: 'lonely',
            fileUri: 'file:///work/notes.tsk',
            line: 0,
            forward: {},
            inverse: { children: [], dependents: [], related: [] },
        };
        const md = buildTaskHoverMarkdown(makeTask({ metadata: new Map([['id', 'lonely']]) }), {
            ...emptyDeps,
            lookupGraph: () => node,
        });
        expect(md).not.toContain('children');
        expect(md).not.toContain('dependents');
        expect(md).not.toContain('related');
    });

    it('skips inverse rendering when the task has no @id', () => {
        // Without @id, the graph lookup can't even start. Forward + tags still
        // render; inverse is omitted entirely.
        const md = buildTaskHoverMarkdown(makeTask(), emptyDeps);
        expect(md).not.toContain('children');
        expect(md).not.toContain('dependents');
    });

    it('escapes markdown-special characters in a resolved parent link label', () => {
        // The hover doesn't render the source task's own content (it's in
        // the source line under the cursor), but it DOES render resolved
        // target content as link labels — those need escaping.
        const md = buildTaskHoverMarkdown(makeTask({ metadata: new Map([['parent', 'p1']]) }), {
            ...emptyDeps,
            lookupTask: (id) =>
                id === 'p1' ? makeRecord('p1', 'foo `bar` [baz] | qux') : undefined,
        });
        expect(md).toContain('foo \\`bar\\` \\[baz\\] \\| qux');
    });

    it('renders the footer with file URI + 1-indexed line', () => {
        const md = buildTaskHoverMarkdown(
            makeTask({ fileUri: 'file:///work/notes.tsk', line: 41 }),
            emptyDeps,
        );
        expect(md).toMatch(/\*file:\/\/\/work\/notes\.tsk:42\*$/);
    });
});
