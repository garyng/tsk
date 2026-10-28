import { describe, expect, it } from 'vitest';
import { agentOf, sessionFocus, sessionTrail, shortSessionId } from './session-focus';
import { buildTaskTree } from './task-tree';

const ids = (nodes: readonly { id: string | undefined }[]) => nodes.map((n) => n.id);

describe('sessionFocus', () => {
    it("is the session's in-progress task with the latest @focused", () => {
        const t = buildTaskTree([
            '- [/] older <!-- @id:a @session:s1 @focused:2026-10-19T10:00:00+00:00 -->',
            '- [/] newer <!-- @id:b @session:s1 @focused:2026-10-19T11:00:00+00:00 -->',
            '- [/] other session, newest <!-- @id:c @session:s2 @focused:2026-10-19T12:00:00+00:00 -->',
            '- [x] done, newest of all <!-- @id:d @session:s1 @focused:2026-10-19T13:00:00+00:00 -->',
        ]);
        expect(sessionFocus(t, 's1')?.id).toBe('b');
        expect(sessionFocus(t, 's2')?.id).toBe('c');
        expect(sessionFocus(t, 'nobody')).toBeUndefined();
    });

    it('compares instants, not strings, across time zones', () => {
        const t = buildTaskTree([
            '- [/] 10:30 UTC <!-- @id:a @session:s @focused:2026-10-19T18:30:00+08:00 -->',
            '- [/] 10:00 UTC <!-- @id:b @session:s @focused:2026-10-19T10:00:00+00:00 -->',
        ]);
        expect(sessionFocus(t, 's')?.id).toBe('a');
    });

    it('breaks a same-second tie in favour of the descendant, then the later line', () => {
        const same = '@focused:2026-10-19T10:00:00+00:00';
        const t = buildTaskTree([
            `- [/] child written first <!-- @id:c @session:s @parent:p ${same} -->`,
            `- [/] parent <!-- @id:p @session:s ${same} -->`,
        ]);
        expect(sessionFocus(t, 's')?.id).toBe('c');
        const siblings = buildTaskTree([
            `- [/] a <!-- @id:a @session:s ${same} -->`,
            `- [/] b <!-- @id:b @session:s ${same} -->`,
        ]);
        expect(sessionFocus(siblings, 's')?.id).toBe('b');
    });

    it('falls back to @started when nothing was focused', () => {
        const t = buildTaskTree([
            '- [/] a <!-- @id:a @session:s @started:2026-10-19T12:00:00+00:00 -->',
            '- [/] b <!-- @id:b @session:s @started:2026-10-19T09:00:00+00:00 -->',
        ]);
        expect(sessionFocus(t, 's')?.id).toBe('a');
    });

    it('skips a task handed to an agent, however recent', () => {
        const t = buildTaskTree([
            '- [/] mine <!-- @id:a @session:s @focused:2026-10-19T10:00:00+00:00 -->',
            '  - [/] theirs <!-- @id:b @session:s @agent:alpha @focused:2026-10-19T11:00:00+00:00 -->',
        ]);
        expect(sessionFocus(t, 's')?.id).toBe('a');
    });
});

describe('sessionTrail', () => {
    it('lists the path to the focus, its open children, and the rest still open', () => {
        const t = buildTaskTree([
            '- [/] plan <!-- @id:p @session:s @focused:2026-10-19T09:00:00+00:00 -->',
            '  - [ ] parked for later <!-- @id:k @session:s -->',
            '  - [/] phase <!-- @id:ph @session:s @focused:2026-10-19T10:00:00+00:00 -->',
            '    - [ ] next step <!-- @id:n @session:s -->',
            '    - [x] finished step <!-- @id:f @session:s -->',
            '- [ ] somebody else <!-- @id:o @session:s2 -->',
        ]);
        const trail = sessionTrail(t, 's');
        expect(trail.focus?.id).toBe('ph');
        expect(ids(trail.path)).toEqual(['p', 'ph']);
        expect(ids(trail.openChildren)).toEqual(['n']);
        expect(ids(trail.otherOpen)).toEqual(['k']);
    });

    it('is empty without a focus but still lists open tasks', () => {
        const trail = sessionTrail(buildTaskTree(['- [ ] queued <!-- @id:q @session:s -->']), 's');
        expect(trail.focus).toBeUndefined();
        expect(trail.path).toEqual([]);
        expect(ids(trail.otherOpen)).toEqual(['q']);
    });

    it("lists the session's open agent tasks apart, under the focus or not", () => {
        const t = buildTaskTree([
            '- [/] plan <!-- @id:p @session:s @focused:2026-10-19T09:00:00+00:00 -->',
            '  - [/] probe <!-- @id:a1 @session:s @agent:alpha -->',
            '  - [ ] next <!-- @id:n @session:s -->',
            '- [/] elsewhere <!-- @id:a2 @session:s @agent:beta -->',
            '- [x] reported back <!-- @id:a3 @session:s @agent:alpha -->',
            '- [/] another session <!-- @id:a4 @session:s2 @agent:gamma -->',
        ]);
        const trail = sessionTrail(t, 's');
        expect(trail.focus?.id).toBe('p');
        expect(ids(trail.openChildren)).toEqual(['n']);
        expect(ids(trail.withAgents)).toEqual(['a1', 'a2']);
        expect(ids(trail.otherOpen)).toEqual([]);
    });
});

describe('agentOf', () => {
    it("is the agent's name, or undefined", () => {
        const [a, b] = buildTaskTree([
            '- [/] a <!-- @id:a @agent:alpha -->',
            '- [/] b <!-- @id:b -->',
        ]).nodes;
        expect(a && agentOf(a)).toBe('alpha');
        expect(b && agentOf(b)).toBeUndefined();
    });
});

describe('shortSessionId', () => {
    it('keeps the first 8 characters of a session UUID', () => {
        expect(shortSessionId('0123abcd-4567-89ef-0123-456789abcdef')).toBe('0123abcd');
    });
});
