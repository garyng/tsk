import { describe, expect, it } from 'vitest';
import { anchorIndex, type DetailLine, markdownLines, taskLineIn } from './markdown-lines';

const text = (l: DetailLine) => l.spans.map((s) => s.text).join('');
const texts = (lines: readonly DetailLine[]) => lines.map(text);
/** Each non-plain span as `tone:text`, to check what's picked out. */
const marked = (lines: readonly DetailLine[]) =>
    lines.flatMap((l) =>
        l.spans.filter((s) => s.tone !== 'plain').map((s) => `${s.tone}:${s.text}`),
    );

describe('markdownLines', () => {
    it('renders headings in their tone with a blank line before, and paragraphs wrapped', () => {
        const lines = markdownLines('# Title\nintro words here\n\n## Next\nmore', 12);
        expect(texts(lines)).toEqual(['Title', 'intro words', 'here', '', 'Next', 'more']);
        expect(lines[0]?.spans).toEqual([{ text: 'Title', tone: 'heading' }]);
    });

    it('picks out strong, emphasis, code, links and tsk:<id>, the selected task as the target', () => {
        const lines = markdownLines(
            'a **bold** and *em* and `code` and [a link](http://x) tsk:aaaa1111 tsk:bbbb2222',
            200,
            'bbbb2222',
        );
        expect(marked(lines)).toEqual([
            'strong:bold',
            'em:em',
            'code:code',
            'link:a link',
            'ref:tsk:aaaa1111',
            'target:tsk:bbbb2222',
        ]);
    });

    it('bullets lists, hangs their wrapped lines, indents nested ones, and numbers ordered ones', () => {
        const md =
            '- one two three four\n  - nested\n- [x] done\n- [ ] open\n\n3. third\n4. fourth';
        expect(texts(markdownLines(md, 12))).toEqual([
            '• one two',
            '  three four',
            '  • nested',
            '• ✓ done',
            '• ○ open',
            '',
            '3. third',
            '4. fourth',
        ]);
        expect(marked(markdownLines('- [x] done', 20))).toContain('done:✓ ');
    });

    it('keeps code as written, indented and cut at the width rather than wrapped', () => {
        const lines = markdownLines('```ts\nconst a = 1;\n    deep();\n```', 10);
        expect(texts(lines)).toEqual(['  const a ', '  = 1;', '      deep', '  ();']);
        expect(lines.every((l) => l.spans.every((s) => s.tone === 'code'))).toBe(true);
    });

    it('bars quotes, rules a thematic break, and drops HTML comments', () => {
        expect(texts(markdownLines('> said\n\n---\n\n<!-- hidden -->\nafter', 6))).toEqual([
            '│ said',
            '',
            '──────',
            '',
            'after',
        ]);
    });

    it('aligns a table that fits, and runs each row on one wrapped line when it does not', () => {
        const md = '| name | n |\n|---|---|\n| a | 10 |\n| bbb | 2 |';
        expect(texts(markdownLines(md, 40))).toEqual([
            'name │ n ',
            '─────┼───',
            'a    │ 10',
            'bbb  │ 2 ',
        ]);
        expect(texts(markdownLines(md, 6))).toEqual(['name │', 'n', 'a │ 10', 'bbb │', '2']);
    });

    it("remembers each block's source line, list items each their own", () => {
        const md = '# T\n\npara\n\n- x\n- y\n  more of y\n\n```\nc1\nc2\n```';
        const lines = markdownLines(md, 40);
        expect(lines.map((l) => [text(l), l.source])).toEqual([
            ['T', 0],
            ['', undefined],
            ['para', 2],
            ['', undefined],
            ['• x', 4],
            ['• y more of y', 5],
            ['', undefined],
            ['  c1', 9],
            ['  c2', 10],
        ]);
    });

    it('places a block whose text also appears earlier at its own line', () => {
        const lines = markdownLines('see - a below\n\n- a', 40);
        expect(lines.at(-1)).toMatchObject({ source: 2 });
    });
});

describe('taskLineIn', () => {
    it('finds the first line naming tsk:<id>, and only that exact id', () => {
        const md = 'intro\n- tsk:abc123ef longer\n- tsk:abc the one\n- tsk:abc again';
        expect(taskLineIn(md, 'abc')).toBe(2);
        expect(taskLineIn(md, 'abc123ef')).toBe(1);
        expect(taskLineIn(md, 'zzz')).toBeUndefined();
    });
});

describe('anchorIndex', () => {
    it('is the first rendered line of the block holding the source line', () => {
        const lines = markdownLines(
            '# T\n\nlong paragraph that wraps\nover two source lines\n\n- x',
            10,
        );
        expect(anchorIndex(lines, 3)).toBe(2); // inside the paragraph: its first line
        expect(text(lines[anchorIndex(lines, 5)] as DetailLine)).toBe('• x');
        expect(anchorIndex(lines, 0)).toBe(0);
    });
});
