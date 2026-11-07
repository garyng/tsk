import { describe, expect, it } from 'vitest';
import { commitMessage, fileChanges } from './task-changes';

const line = (marker: string, text: string, meta: string, indent = '') =>
    `${indent}- [${marker}] ${text} <!-- ${meta} -->`;

describe('fileChanges', () => {
    it('names each change a task went through, matched by @id', () => {
        const before = [
            line(' ', 'the plan', '@id:root0001 @session:aaaa0001'),
            line(' ', 'to finish', '@id:done0001 @session:aaaa0001', '  '),
            line(' ', 'to drop', '@id:canc0001 @session:aaaa0001', '  '),
            line(' ', 'to hand on', '@id:move0001 @session:aaaa0001', '  '),
            line(' ', 'to start', '@id:strt0001 @session:aaaa0001', '  '),
            line('/', 'to park', '@id:park0001 @session:aaaa0001', '  '),
            line('x', 'to reopen', '@id:reop0001 @session:aaaa0001', '  '),
            line(' ', 'old words', '@id:rewd0001 @session:aaaa0001', '  '),
            line(' ', 'to wait', '@id:chng0001 @session:aaaa0001', '  '),
            line(' ', 'gone', '@id:gone0001 @session:aaaa0001', '  '),
            line(' ', 'another root', '@id:root0002 @session:aaaa0001'),
            line(' ', 'to put elsewhere', '@id:repa0001 @session:aaaa0001', '  '),
        ];
        const after = [
            line(' ', 'the plan', '@id:root0001 @session:aaaa0001'),
            line('x', 'to finish', '@id:done0001 @session:aaaa0001', '  '),
            line('!', 'to drop', '@id:canc0001 @session:aaaa0001', '  '),
            line('>', 'to hand on', '@id:move0001 @session:aaaa0001', '  '),
            line('/', 'to start', '@id:strt0001 @session:aaaa0001', '  '),
            line(' ', 'to park', '@id:park0001 @session:aaaa0001', '  '),
            line(' ', 'to reopen', '@id:reop0001 @session:aaaa0001', '  '),
            line(' ', 'new words', '@id:rewd0001 @session:aaaa0001', '  '),
            line(' ', 'to wait', '@id:chng0001 @session:aaaa0001 @dependsOn:root0002', '  '),
            line(' ', 'to put elsewhere', '@id:repa0001 @session:aaaa0001', '  '),
            line(' ', 'new', '@id:new00001 @session:aaaa0001', '  '),
            line(' ', 'another root', '@id:root0002 @session:aaaa0001'),
        ];
        const changes = fileChanges(before, after);
        expect(changes.sessions).toHaveLength(1);
        expect(changes.sessions[0]?.tasks.map((t) => [t.id, t.kinds.join(', ')])).toEqual([
            ['done0001', 'done'],
            ['canc0001', 'cancelled'],
            ['move0001', 'moved'],
            ['strt0001', 'started'],
            ['park0001', 'parked'],
            ['reop0001', 'reopened'],
            ['rewd0001', 'reworded'],
            ['chng0001', 'changed'],
            ['repa0001', 'reparented'],
            ['new00001', 'added'],
            ['gone0001', 'removed'],
        ]);
    });

    it('lists every change of one task on its line', () => {
        const changes = fileChanges(
            [line(' ', 'first words', '@id:t1 @session:aaaa0001')],
            [line('x', 'second words', '@id:t1 @session:aaaa0001')],
        );
        expect(changes.sessions[0]?.tasks[0]?.kinds).toEqual(['done', 'reworded']);
    });

    it("doesn't list a task whose focus stamps alone changed", () => {
        const changes = fileChanges(
            [line('/', 'work', '@id:t1 @session:aaaa0001 @started:2026-11-01T10:00:00+00:00')],
            [
                line(
                    '/',
                    'work',
                    '@id:t1 @session:aaaa0001 @started:2026-11-07T10:00:00+00:00 @focused:2026-11-07T10:00:00.123+00:00',
                ),
            ],
        );
        expect(changes).toEqual({ sessions: [], otherLines: false, reordered: false });
    });

    it('groups by the owning session, in the order they first change, those without one last', () => {
        const changes = fileChanges(
            [],
            [
                line(' ', 'by hand', '@id:hand0001'),
                line(' ', 'b', '@id:bbbb0001 @session:bbbb0001'),
                line(' ', 'a', '@id:aaaa0001 @session:aaaa0001'),
                line(' ', 'b again', '@id:bbbb0002 @session:bbbb0001'),
            ],
        );
        expect(changes.sessions.map((s) => [s.session, s.tasks.map((t) => t.id)])).toEqual([
            ['bbbb0001', ['bbbb0001', 'bbbb0002']],
            ['aaaa0001', ['aaaa0001']],
            [undefined, ['hand0001']],
        ]);
    });

    it('notices lines without an @id, and tasks that only changed places', () => {
        const a = line(' ', 'a', '@id:a');
        const b = line(' ', 'b', '@id:b');
        expect(fileChanges(['# Tasks', a], ['# Plans', a]).otherLines).toBe(true);
        expect(fileChanges(['- [ ] no id', a], ['- [x] no id', a]).otherLines).toBe(true);
        expect(fileChanges(['', a], [a, '']).otherLines).toBe(false);
        expect(fileChanges([a, b], [b, a]).reordered).toBe(true);
        expect(fileChanges([a, b], [a, b, line(' ', 'c', '@id:c')]).reordered).toBe(false);
    });
});

describe('commitMessage', () => {
    it('names the sessions, then a line for each task', () => {
        const changes = fileChanges(
            [line(' ', 'the plan [[plans/x.md]]', '@id:t1 @session:aaaa0001')],
            [
                line('x', 'the plan [[plans/x.md]]', '@id:t1 @session:aaaa0001'),
                line(' ', 'theirs', '@id:t2 @session:bbbb0001'),
                line(' ', 'by hand', '@id:t3'),
            ],
        );
        expect(commitMessage('claude.tsk', changes)).toBe(
            [
                'chore: claude.tsk from aaaa0001, bbbb0001',
                '',
                'aaaa0001:',
                '  done tsk:t1 the plan',
                'bbbb0001:',
                '  added tsk:t2 theirs',
                'without a session:',
                '  added tsk:t3 by hand',
                '',
            ].join('\n'),
        );
    });

    it('counts the sessions past three', () => {
        const after = ['s1', 's2', 's3', 's4'].map((s) => line(' ', s, `@id:${s} @session:${s}`));
        expect(commitMessage('claude.tsk', fileChanges([], after)).split('\n')[0]).toBe(
            'chore: claude.tsk from 4 sessions',
        );
    });

    it('cuts a long title to fit the line', () => {
        const title = 'a task whose text runs on for much longer than any commit line should';
        const msg = commitMessage('claude.tsk', fileChanges([], [line(' ', title, '@id:t1')]));
        const taskLine = msg.split('\n')[3] ?? '';
        expect(taskLine.length).toBe(72);
        expect(taskLine).toMatch(/^ {2}added tsk:t1 a task whose .*…$/);
    });

    it('says what changed when no task line did', () => {
        const a = line(' ', 'a', '@id:a @session:aaaa0001');
        const b = line(' ', 'b', '@id:b @session:aaaa0001');
        const focused = line(
            ' ',
            'a',
            '@id:a @session:aaaa0001 @focused:2026-11-07T10:00:00+00:00',
        );
        expect(commitMessage('claude.tsk', fileChanges([a], [focused]))).toBe(
            'chore: claude.tsk, focus stamps\n\nOnly focus stamps changed.\n',
        );
        expect(commitMessage('claude.tsk', fileChanges([a, b], [b, a]))).toBe(
            'chore: claude.tsk, reordered\n\nTasks moved within the file.\n',
        );
        expect(commitMessage('claude.tsk', fileChanges(['# Tasks', a], ['# Plans', a]))).toBe(
            'chore: claude.tsk, edited by hand\n\nLines without an @id changed too.\n',
        );
    });

    it("doesn't say tasks moved when the move is a task put under another", () => {
        const msg = commitMessage(
            'claude.tsk',
            fileChanges(
                [line(' ', 'p', '@id:p'), line(' ', 'q', '@id:q'), line(' ', 'c', '@id:c', '  ')],
                [line(' ', 'p', '@id:p'), line(' ', 'c', '@id:c', '  '), line(' ', 'q', '@id:q')],
            ),
        );
        expect(msg).toContain('reparented tsk:c c');
        expect(msg).not.toContain('Tasks moved');
    });
});
