import { describe, expect, it } from 'vitest';
import type { DetailLine } from './markdown-lines';
import { buildTaskTree, type TreeNode, withOutside } from './task-tree';
import {
    AUTO_HIDE_BELOW,
    detailWindow,
    factLines,
    linkedFile,
    namedLine,
    SHARE_STEP,
    shareAt,
    splitPane,
    stepShare,
    taskFacts,
} from './tui-detail';

const tree = buildTaskTree([
    '- [/] #p/x the plan — big [[plans/x.md]] <!-- @id:p @session:0123456789abcdef -->',
    '  - [/] phase one: details <!-- @id:p1 @created:2026-10-19T09:00:00+00:00 @started:2026-10-19T10:30:00+00:00 @session:0123456789abcdef @dependsOn:gone -->',
    '    - [x] step a <!-- @id:a -->',
    '    - [ ] step b <!-- @id:b @dependsOn:c -->',
    '    - [!] step d <!-- @id:d -->',
    '  - [ ] phase two [[plans/two.md]] <!-- @id:p2 @dependsOn:p1 -->',
    '- [ ] c <!-- @id:c -->',
]);
const node = (id: string): TreeNode => {
    const n = tree.byId.get(id);
    if (!n) throw new Error(id);
    return n;
};
const texts = (lines: readonly DetailLine[]) =>
    lines.map((l) => l.spans.map((s) => s.text).join(''));

describe('taskFacts', () => {
    it("gathers a task's state, stamps, session, place, dependencies and children", () => {
        expect(taskFacts(tree, node('p1'))).toEqual({
            id: 'p1',
            marker: 'inprogress',
            content: 'phase one: details',
            times: [
                { key: 'created', at: '2026-10-19 09:00' },
                { key: 'started', at: '2026-10-19 10:30' },
            ],
            session: '01234567',
            path: ['the plan'],
            waitsOn: [{ id: 'gone', title: undefined, through: undefined }],
            neededBy: [{ id: 'p2', title: 'phase two' }],
            children: { open: 1, finished: 2 },
        });
    });

    it('says what a task waits on through the tasks above it', () => {
        expect(taskFacts(tree, node('b')).waitsOn).toEqual([
            { id: 'gone', title: undefined, through: 'phase one' },
            { id: 'c', title: 'c', through: undefined },
        ]);
    });
});

describe('factLines', () => {
    it('shows state and id, the full text, then only the facts that apply', () => {
        expect(texts(factLines(taskFacts(tree, node('p1')), 80))).toEqual([
            '◐ in progress · p1',
            'phase one: details',
            'created 2026-10-19 09:00 · started 2026-10-19 10:30 · session 01234567',
            'in the plan',
            'waits on gone (not in any file)',
            'needed by p2 phase two',
            'children 1 open · 2 finished',
        ]);
        expect(texts(factLines(taskFacts(tree, node('a')), 80))).toEqual([
            '✓ done · a',
            'step a',
            'in the plan › phase one',
        ]);
    });

    it('names the agent a task was handed to, after its session', () => {
        const t = buildTaskTree([
            '- [/] probe <!-- @id:a @started:2026-10-19T10:30:00+00:00 @session:0123456789abcdef @agent:alpha -->',
        ]);
        const n = t.byId.get('a');
        expect(n && texts(factLines(taskFacts(t, n), 80))[2]).toBe(
            'started 2026-10-19 10:30 · session 01234567 · agent alpha',
        );
    });

    it('shows a [[link]] as its file name and wraps to the width', () => {
        const lines = texts(factLines(taskFacts(tree, node('p')), 12));
        expect(lines).toContain('x.md');
        expect(lines.every((l) => l.length <= 12)).toBe(true);
        expect(lines.join(' ')).toContain('#p/x the plan — big x.md');
    });
});

describe('linkedFile', () => {
    it("is the task's own link, else its nearest linked ancestor's, else none", () => {
        expect(linkedFile(node('p2'))).toMatchObject({ path: 'plans/two.md', from: node('p2') });
        expect(linkedFile(node('a'))).toMatchObject({ path: 'plans/x.md', from: node('p') });
        expect(linkedFile(node('c'))).toBeUndefined();
    });

    it('is the file a #heading link names, without the heading', () => {
        const t = buildTaskTree(['- [ ] step [[plans/x.md#phase-1]] <!-- @id:s -->']);
        const n = t.byId.get('s');
        expect(n && linkedFile(n)?.path).toBe('plans/x.md');
    });
});

describe('namedLine', () => {
    it('is the line naming the task, else the nearest ancestor the plan names', () => {
        const md = '# x\n- tsk:p the plan\n- tsk:p1 phase one\n- tsk:b step b';
        expect(namedLine(md, node('b'))).toBe(3);
        expect(namedLine(md, node('a'))).toBe(2);
        expect(namedLine(md, node('c'))).toBeUndefined();
    });
});

describe('splitPane', () => {
    it('hides the pane below the auto height unless asked for, and shows it when asked', () => {
        expect(splitPane(60, 20, AUTO_HIDE_BELOW - 1, undefined).shown).toBe(false);
        expect(splitPane(60, 40, AUTO_HIDE_BELOW, undefined).shown).toBe(true);
        expect(splitPane(60, 40, 80, false).shown).toBe(false);
        expect(splitPane(60, 20, 23, true).shown).toBe(true);
    });

    it('stacks it under the list in 40% of the height in a narrow pane', () => {
        expect(splitPane(60, 50, 53, undefined)).toEqual({
            shown: true,
            side: false,
            listWidth: 60,
            listRows: 30,
            detailWidth: 60,
            detailRows: 20,
        });
    });

    it('puts it beside the list from 100 columns, in 40% of the width', () => {
        expect(splitPane(100, 30, 33, undefined)).toEqual({
            shown: true,
            side: true,
            listWidth: 60,
            listRows: 30,
            detailWidth: 40,
            detailRows: 30,
        });
    });

    it('keeps it hidden when the list and the pane would not both get three lines', () => {
        expect(splitPane(60, 5, 8, true).shown).toBe(false);
        expect(splitPane(60, 8, 11, true)).toMatchObject({ listRows: 5, detailRows: 3 });
    });

    it('gives the pane the share asked for, of the height stacked and of the width beside', () => {
        expect(splitPane(60, 50, 53, undefined, 0.6)).toMatchObject({
            listRows: 20,
            detailRows: 30,
        });
        expect(splitPane(120, 30, 33, undefined, 0.25)).toMatchObject({
            listWidth: 90,
            detailWidth: 30,
        });
    });

    it('leaves the list and the pane three lines each, or twenty columns beside', () => {
        expect(splitPane(60, 50, 53, undefined, 0.99)).toMatchObject({
            listRows: 3,
            detailRows: 47,
        });
        expect(splitPane(60, 50, 53, undefined, 0.01)).toMatchObject({
            listRows: 47,
            detailRows: 3,
        });
        expect(splitPane(120, 30, 33, undefined, 0.99)).toMatchObject({
            listWidth: 20,
            detailWidth: 100,
        });
        expect(splitPane(120, 30, 33, undefined, 0.01)).toMatchObject({
            listWidth: 100,
            detailWidth: 20,
        });
    });
});

describe('stepShare', () => {
    it('grows or shrinks the pane by a step of its axis, from the size it has now', () => {
        const stacked = splitPane(60, 40, 43, undefined); // 16 of 40 rows
        expect(stacked.detailRows).toBe(16);
        expect(splitPane(60, 40, 43, undefined, stepShare(stacked, 60, 40, 1)).detailRows).toBe(18);
        expect(splitPane(60, 40, 43, undefined, stepShare(stacked, 60, 40, -1)).detailRows).toBe(
            14,
        );
        const side = splitPane(100, 30, 33, undefined); // 40 of 100 columns
        expect(stepShare(side, 100, 30, 1)).toBeCloseTo(0.4 + SHARE_STEP);
        expect(stepShare(side, 100, 30, -1)).toBeCloseTo(0.4 - SHARE_STEP);
    });

    it('moves at least a line when a step rounds to nothing', () => {
        const small = splitPane(60, 9, 12, true); // 4 of 9 rows; 5% of 9 rounds to 0
        expect(splitPane(60, 9, 12, true, stepShare(small, 60, 9, 1)).detailRows).toBe(
            small.detailRows + 1,
        );
    });

    it('stops at the limits, so a step back always shows', () => {
        let split = splitPane(60, 20, 23, true);
        for (let i = 0; i < 20; i++)
            split = splitPane(60, 20, 23, true, stepShare(split, 60, 20, 1));
        expect(split.detailRows).toBe(17);
        const back = splitPane(60, 20, 23, true, stepShare(split, 60, 20, -1));
        expect(back.detailRows).toBe(16);
    });
});

describe('shareAt', () => {
    it("puts the stacked pane's top rule on the pointer's line", () => {
        // 40 rows to divide; the pointer on line 10 of them leaves the list 10 and the pane 30.
        const share = shareAt(false, 60, 40, 5, 10);
        expect(splitPane(60, 40, 43, undefined, share)).toMatchObject({
            listRows: 10,
            detailRows: 30,
        });
    });

    it("puts the side pane's border on the pointer's column", () => {
        const share = shareAt(true, 110, 30, 70, 3);
        expect(splitPane(110, 30, 33, undefined, share)).toMatchObject({
            listWidth: 70,
            detailWidth: 40,
        });
    });

    it('keeps to the limits when the pointer goes past them', () => {
        expect(splitPane(60, 40, 43, undefined, shareAt(false, 60, 40, 0, -5)).detailRows).toBe(37);
        expect(splitPane(60, 40, 43, undefined, shareAt(false, 60, 40, 0, 45)).detailRows).toBe(3);
        expect(splitPane(110, 30, 33, undefined, shareAt(true, 110, 30, 2, 0)).detailWidth).toBe(
            90,
        );
        expect(splitPane(110, 30, 33, undefined, shareAt(true, 110, 30, 109, 0)).detailWidth).toBe(
            20,
        );
    });
});

describe('detailWindow', () => {
    it('gives the facts at most half the pane and the file the rest, under two rules', () => {
        expect(detailWindow(20, 3, 100, 0)).toEqual({ facts: 3, fileRows: 15, top: 0 });
        expect(detailWindow(20, 30, 100, 0)).toEqual({ facts: 9, fileRows: 9, top: 0 });
    });

    it('clamps the top so the window stays full', () => {
        expect(detailWindow(20, 3, 100, 95)).toMatchObject({ top: 85 });
        expect(detailWindow(20, 3, 10, 5)).toMatchObject({ top: 0 });
        expect(detailWindow(20, 3, 100, -4)).toMatchObject({ top: 0 });
    });
});

describe('a task in a file beside it', () => {
    it('sits in that file first', () => {
        const backlog = buildTaskTree([
            '- [ ] group <!-- @id:g -->',
            '  - [ ] theirs <!-- @id:x -->',
        ]);
        const t = withOutside(buildTaskTree(['- [ ] ours <!-- @id:a @dependsOn:x -->']), [
            { file: '/w/stack.tsk', tree: backlog },
        ]);
        const x = backlog.byId.get('x') as TreeNode;
        expect(taskFacts(t, x).path).toEqual(['stack.tsk', 'group']);
        expect(taskFacts(t, t.byId.get('a') as TreeNode).waitsOn).toEqual([
            { id: 'x', title: 'theirs', through: undefined },
        ]);
    });
});
