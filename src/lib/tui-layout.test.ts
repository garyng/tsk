import { describe, expect, it } from 'vitest';
import { buildTaskTree } from './task-tree';
import { HELP_KEYS_WIDTH, helpLines } from './tui-keys';
import {
    contentSpans,
    FOCUS_MARK,
    FOLD_MARK,
    guideText,
    headingText,
    helpRows,
    lineHeight,
    listWindow,
    MARKED_MARK,
    scrollRows,
    taskRow,
    viewWindow,
    wrapSpans,
} from './tui-layout';
import type { TaskLine } from './tui-view-model';

const tree = buildTaskTree([
    '- [/] #p/tsk tsk for Claude [[notes/2026-10-19_x.md]] <!-- @id:p -->',
    '  - [ ] a task whose text is long enough to wrap in a narrow pane <!-- @id:a @dependsOn:b -->',
    '  - [ ] b <!-- @id:b -->',
]);
const node = (id: string) => {
    const n = tree.byId.get(id);
    if (!n) throw new Error(id);
    return n;
};
const line = (id: string, over: Partial<TaskLine> = {}): TaskLine => ({
    kind: 'task',
    node: node(id),
    depth: 0,
    chained: false,
    focus: false,
    waits: 0,
    needed: 0,
    ...over,
});
const texts = (spans: readonly { text: string }[]) => spans.map((s) => s.text).join('');

describe('contentSpans', () => {
    it('picks out #tags and shows a [[link]] as its file name', () => {
        expect(contentSpans('#p/tsk tsk for Claude [[notes/2026-10-19_x.md]] now')).toEqual([
            { text: '#p/tsk', tone: 'tag' },
            { text: ' tsk for Claude ', tone: 'plain' },
            { text: '2026-10-19_x.md', tone: 'link' },
            { text: ' now', tone: 'plain' },
        ]);
    });
    it('is one plain span for plain text', () => {
        expect(contentSpans('just words')).toEqual([{ text: 'just words', tone: 'plain' }]);
    });
    it('shows a [[link#heading]] as the file, then the heading as the lookup reads it, else the fragment as written', () => {
        const text = 'see [[plans/x.md#46-links-between-plans-and-tasks]] first';
        const asked: [string, string][] = [];
        const headingOf = (path: string, fragment: string) => {
            asked.push([path, fragment]);
            return fragment.startsWith('46-') ? '4.6 Links between plans and tasks' : undefined;
        };
        expect(contentSpans(text, headingOf)[1]).toEqual({
            text: 'x.md › 4.6 Links between plans and tasks',
            tone: 'link',
        });
        expect(asked).toEqual([['plans/x.md', '46-links-between-plans-and-tasks']]);
        expect(contentSpans('[[plans/x.md#gone]]', headingOf)).toEqual([
            { text: 'x.md#gone', tone: 'link' },
        ]);
        expect(contentSpans(text)[1]?.text).toBe('x.md#46-links-between-plans-and-tasks');
    });
});

describe('taskRow', () => {
    it('starts with the focus gutter and the state glyph; badges and the note follow the text', () => {
        const row = taskRow(line('a', { focus: true, waits: 1, needed: 2, note: 'in p' }), 40);
        expect(texts(row.prefix)).toBe(`${FOCUS_MARK}○ `);
        expect(row.prefixWidth).toBe(3);
        const spans = row.lines.flatMap((l) => l.spans);
        expect(spans.filter((s) => s.tone !== 'plain')).toEqual([
            { text: '◀1', tone: 'waits' },
            { text: '▶2', tone: 'needed' },
            { text: '  in p', tone: 'note' },
        ]);
    });
    it('puts ● in the gutter of a marked task, over the focus mark', () => {
        expect(texts(taskRow(line('a', { focus: true }), 40, [], undefined, true).prefix)).toBe(
            `${MARKED_MARK}○ `,
        );
    });
    it('marks a folded row with ▸ in the space before its state glyph, so its text lines up with the rows beside it', () => {
        const row = taskRow(line('b', { folded: 3 }), 40);
        expect(texts(row.prefix)).toBe(`${FOLD_MARK}○ `);
        expect(row.prefix.find((s) => s.text === FOLD_MARK)?.tone).toBe('fold');
        expect(row.prefixWidth).toBe(3);
        expect(texts(taskRow(line('b'), 40).prefix)).toBe(' ○ ');
        const under = (over: Partial<TaskLine>) =>
            texts(taskRow(line('b', { folded: 3, ...over }), 40).prefix);
        expect(under({ depth: 1, lasts: [false] })).toBe(` │${FOLD_MARK}○ `);
        expect(under({ depth: 2, lasts: [false, true] })).toBe(` │ └${FOLD_MARK}○ `);
        expect(under({ depth: 1 })).toBe(`  ${FOLD_MARK}○ `);
        expect(under({ depth: 1, lasts: [true], chained: true })).toBe(` └ ›${FOLD_MARK}○ `);
    });
    it("puts ▸ before the state glyph where the gutter holds the focus's or a mark's sign, as nothing is in between", () => {
        const row = taskRow(line('b', { folded: 3, focus: true }), 40);
        expect(texts(row.prefix)).toBe(`${FOCUS_MARK}${FOLD_MARK}○ `);
        expect(row.prefixWidth).toBe(4);
        expect(texts(taskRow(line('b', { folded: 3 }), 40, [], undefined, true).prefix)).toBe(
            `${MARKED_MARK}${FOLD_MARK}○ `,
        );
    });
    it('says how many tasks a fold hides, straight after the text', () => {
        const row = taskRow(line('b', { folded: 3, waits: 1 }), 40);
        const spans = row.lines.flatMap((l) => l.spans);
        expect(spans.filter((s) => s.tone !== 'plain')).toEqual([
            { text: '+3', tone: 'folded' },
            { text: '◀1', tone: 'waits' },
        ]);
    });
    it("splits the filter's terms out of the text as matches, in tags and links too", () => {
        const row = taskRow(line('p'), 80, ['TSK', 'x.md']);
        const spans = row.lines.flatMap((l) => l.spans);
        expect(spans.slice(0, 6)).toEqual([
            { text: '#p/', tone: 'tag' },
            { text: 'tsk', tone: 'match' },
            { text: ' ', tone: 'plain' },
            { text: 'tsk', tone: 'match' },
            { text: ' for Claude ', tone: 'plain' },
            { text: '2026-10-19_', tone: 'link' },
        ]);
        expect(spans[6]).toEqual({ text: 'x.md', tone: 'match' });
    });
    it('shows the @id after the text when a term is found only at its start, that much highlighted', () => {
        const row = taskRow(line('b', { waits: 1 }), 40, ['B']);
        expect(texts(row.lines.flatMap((l) => l.spans))).toBe('b  ◀1'); // 'b' is in the text
        const t = buildTaskTree(['- [ ] the plan <!-- @id:9skgz2qt -->']);
        const byId = { ...line('b', { waits: 1 }), node: t.byId.get('9skgz2qt') ?? node('b') };
        const spans = taskRow(byId, 40, ['9SK', 'plan']).lines.flatMap((l) => l.spans);
        expect(spans.slice(-5)).toEqual([
            { text: '  ', tone: 'plain' },
            { text: '9sk', tone: 'match' },
            { text: 'gz2qt', tone: 'note' },
            { text: '  ', tone: 'plain' },
            { text: '◀1', tone: 'waits' },
        ]);
        expect(lineHeight(byId, 22, ['9sk'])).toBe(2);
        expect(lineHeight(byId, 22)).toBe(1);
    });
    it('highlights nothing on a row shown only as context', () => {
        const row = taskRow(line('b', { context: true }), 40, ['b']);
        expect(row.lines.flatMap((l) => l.spans).some((s) => s.tone === 'match')).toBe(false);
    });
    it('indents by depth after the gutter, and marks a chained row', () => {
        const row = taskRow(line('b', { depth: 2, chained: true }), 60);
        expect(texts(row.prefix)).toBe('     › ○ ');
    });
    it('draws tree lines when it knows where each level ends, and carries them onto wrapped lines', () => {
        const row = taskRow(line('a', { depth: 2, lasts: [false, true] }), 30);
        expect(texts(row.prefix)).toBe(' │ └ ○ ');
        expect(texts(row.continuation)).toBe(' │     ');
        expect(row.lines.length).toBeGreaterThan(1);
    });
    it('shows each state by its shape', () => {
        const t = buildTaskTree(['- [x] done <!-- @id:d -->', '- [!] dropped <!-- @id:x -->']);
        const glyph = (id: string) =>
            texts(taskRow({ ...line('a'), node: t.byId.get(id) ?? node('a') }, 40).prefix).trim();
        expect([glyph('d'), glyph('x')]).toEqual(['✓', '✕']);
    });
});

describe('guideText', () => {
    it('puts └ before the last child, │ before one with siblings to come, and blanks past the end', () => {
        expect(guideText([true], 1, false)).toBe('└ ');
        expect(guideText([false], 1, false)).toBe('│ ');
        expect(guideText([true, false], 2, false)).toBe('  │ ');
        expect(guideText([false, true], 2, true)).toBe('│   ');
    });
    it('draws nothing at the top level, and only the shallowest levels past the depth cap', () => {
        expect(guideText([], 0, false)).toBe('');
        expect(guideText([false, true, false, true], 2, false)).toBe('│ └ ');
    });
});

describe('wrapSpans', () => {
    const lineTexts = (w: number, spans = contentSpans('#tag one two three [[a/b.md]] four')) =>
        wrapSpans(spans, w).map((l) => texts(l.spans));

    it('breaks at words and drops the space at each break, so every line starts flush', () => {
        expect(lineTexts(10)).toEqual(['#tag one', 'two three', 'b.md four']);
    });
    it('keeps each span its tone on both sides of a break', () => {
        const [first, second] = wrapSpans(
            [
                { text: 'plain words ', tone: 'plain' },
                { text: 'in a long note', tone: 'note' },
            ],
            16,
        );
        expect(first?.spans).toEqual([
            { text: 'plain words ', tone: 'plain' },
            { text: 'in a', tone: 'note' },
        ]);
        expect(second?.spans).toEqual([{ text: 'long note', tone: 'note' }]);
    });
    it('splits a word wider than the line', () => {
        expect(lineTexts(4, [{ text: 'abcdefghij', tone: 'plain' }])).toEqual([
            'abcd',
            'efgh',
            'ij',
        ]);
    });
    it('is one empty line for no text', () => {
        expect(wrapSpans([], 10)).toEqual([{ start: 0, spans: [], width: 0 }]);
    });
});

describe('helpRows', () => {
    const W = HELP_KEYS_WIDTH;
    it("wraps a key's help under its own text, the keys on its first row only", () => {
        const help = 'message the followed Claude about it (⏎ sends, esc cancels)';
        const rows = helpRows([{ kind: 'key', keys: 'm', help }], W + 20);
        expect(rows.map((r) => r.keys + r.text)).toEqual([
            `${'m'.padEnd(W)}message the followed`,
            `${' '.repeat(W)}Claude about it (⏎`,
            `${' '.repeat(W)}sends, esc cancels)`,
        ]);
        const all = helpRows(helpLines(), 30);
        expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    });
    it('keeps a short one to a row, and gives a heading and a note rows of their own', () => {
        const rows = helpRows(
            [
                { kind: 'group', text: 'move' },
                { kind: 'key', keys: 'g/G', help: 'top / bottom' },
                { kind: 'note', text: 'background  #1e1e1e, dark' },
            ],
            40,
        );
        expect(rows.map(({ id: _, ...r }) => r)).toEqual([
            { kind: 'group', keys: '', text: headingText('move', 40) },
            { kind: 'key', keys: 'g/G'.padEnd(W), text: 'top / bottom' },
            { kind: 'note', keys: '', text: 'background  #1e1e1e, dark' },
        ]);
    });
});

describe('headingText', () => {
    it('is a rule across the width', () => {
        expect(headingText('also open', 20)).toBe('── also open ───────');
    });
    it('is just the text when it is wider than the pane', () => {
        expect(headingText('a long heading', 10)).toBe('── a long heading');
    });
});

describe('lineHeight', () => {
    it('wraps a task under itself, at the width beside its prefix', () => {
        // prefix ' ○ ' is 3 wide, so the text has 27 columns:
        // "a task whose text is long" / "enough to wrap in a narrow" / "pane"
        expect(lineHeight(line('a'), 30)).toBe(3);
        expect(lineHeight(line('a'), 200)).toBe(1);
    });
    it('counts a crumbs line as one, and a heading as its wrapped lines', () => {
        expect(lineHeight({ kind: 'crumbs', path: [node('p')] }, 10)).toBe(1);
        expect(lineHeight({ kind: 'heading', text: 'also open' }, 40)).toBe(1);
    });
});

describe('listWindow', () => {
    const ones = (n: number) => Array.from({ length: n }, () => 1);

    it('shows everything that fits, with nothing hidden', () => {
        expect(listWindow(ones(5), 4, 0, 10)).toEqual({ top: 0, end: 5, above: 0, below: 0 });
    });
    it('scrolls only once the selection comes within the margin of the bottom', () => {
        // 10 lines: rows 0–8 and "↓ more".
        expect(listWindow(ones(20), 6, 0, 10).top).toBe(0);
        // row 7 needs rows up to 9 in view: "↑ more", rows 2–9, "↓ more"
        expect(listWindow(ones(20), 7, 0, 10)).toEqual({ top: 2, end: 10, above: 2, below: 10 });
    });
    it('keeps the view still while the selection moves inside it', () => {
        expect(listWindow(ones(20), 5, 2, 10).top).toBe(2);
        expect(listWindow(ones(20), 3, 2, 10).top).toBe(1);
    });
    it('counts wrapped rows by their lines', () => {
        // rows of 3 lines: from 0, three fit in 9 of 10 lines, the 10th for "↓ more"
        expect(listWindow([3, 3, 3, 3, 3], 0, 0, 10)).toEqual({
            top: 0,
            end: 3,
            above: 0,
            below: 2,
        });
    });
    it('keeps as much margin as tall rows leave room for', () => {
        // 10 lines, 8 between the "more" lines: rows 3–7 at 2 lines each don't fit,
        // rows 3–6 do — two rows above the selection, one below, not none.
        expect(listWindow([2, 2, 2, 2, 2, 2, 2, 2, 2, 2], 5, 0, 10)).toEqual({
            top: 3,
            end: 7,
            above: 3,
            below: 3,
        });
    });
    it('shows a row taller than the window on its own', () => {
        expect(listWindow([1, 30, 1], 1, 0, 10)).toMatchObject({ top: 1, end: 2 });
    });
    it('pulls the view back when the list shrinks, rather than leave blank lines', () => {
        expect(listWindow(ones(6), 5, 4, 10)).toEqual({ top: 0, end: 6, above: 0, below: 0 });
    });
    it('is empty for no rows', () => {
        expect(listWindow([], 0, 0, 10)).toEqual({ top: 0, end: 0, above: 0, below: 0 });
    });
    it('keeps a view the wheel left, while the selection is inside it past the margin', () => {
        // Scrolled to top 5; the selection on row 9 sits mid-window, so nothing moves.
        expect(listWindow(ones(30), 9, 5, 10).top).toBe(5);
    });
});

describe('viewWindow', () => {
    const ones = (n: number) => Array.from({ length: n }, () => 1);

    it('shows the rows from the top it is given, wherever the selection is', () => {
        expect(viewWindow(ones(30), 12, 10)).toEqual({ top: 12, end: 20, above: 12, below: 10 });
    });
    it('pulls back from the end rather than leave blank lines', () => {
        expect(viewWindow(ones(30), 29, 10)).toEqual({ top: 21, end: 30, above: 21, below: 0 });
    });
});

describe('scrollRows', () => {
    it('moves by whole rows until they add up to the lines asked for', () => {
        expect(scrollRows([1, 1, 1, 1, 1, 1], 0, 3)).toBe(3);
        expect(scrollRows([2, 2, 2, 2], 0, 3)).toBe(2); // two rows, four lines
        expect(scrollRows([5, 1, 1], 0, 3)).toBe(1); // at least one row
        expect(scrollRows([1, 1, 1, 1, 1, 1], 4, -3)).toBe(1);
    });
    it('stops at either end', () => {
        expect(scrollRows([1, 1, 1], 1, -3)).toBe(0);
        expect(scrollRows([1, 1, 1], 1, 3)).toBe(2);
    });
});
