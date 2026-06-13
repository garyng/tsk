import { describe, expect, it } from 'vitest';
import { mouseSelectionInPrefix } from './block-select';
import { taskContentRange } from './toggle';

/**
 * `contentStart` for a line, the way the glue derives it — keeps the test
 * grounded in the real content-start columns rather than hand-counted ones.
 */
const contentStart = (line: string): number => {
    const range = taskContentRange(line);
    if (!range) throw new Error(`not a task line: ${line}`);
    return range.start;
};

describe('mouseSelectionInPrefix', () => {
    // `- [ ] foo` → content starts at col 6 (marker `[`=2, ` `=3, `]`=4, ` `=5).
    const TOP = '- [ ] foo';

    it('a whitespace selection in the indentation is a prefix hit', () => {
        const line = '    - [ ] foo'; // content at col 10; indent is [0,4)
        const cs = contentStart(line);
        expect(mouseSelectionInPrefix(0, 0, 0, 4, cs)).toBe(true);
    });

    it('a marker bracket-interior selection is a prefix hit', () => {
        // Double-clicking `[` selects the interior (col 3, the space) — tsk
        // declares `[ ]` as a bracket pair, so this is the catchable case.
        const cs = contentStart(TOP); // 6
        expect(mouseSelectionInPrefix(0, 3, 0, 4, cs)).toBe(true);
        // bracket-inclusive variant (2..5) still ends before content.
        expect(mouseSelectionInPrefix(0, 2, 0, 5, cs)).toBe(true);
    });

    it('ending exactly at contentStart is a prefix hit (boundary)', () => {
        const cs = contentStart(TOP); // 6
        expect(mouseSelectionInPrefix(0, 5, 0, cs, cs)).toBe(true);
    });

    it('a selection one char into the content is NOT a prefix hit', () => {
        const cs = contentStart(TOP); // 6
        expect(mouseSelectionInPrefix(0, cs, 0, cs + 3, cs)).toBe(false); // "foo"
    });

    it('an empty selection (a plain click) is not a prefix hit', () => {
        expect(mouseSelectionInPrefix(0, 3, 0, 3, 6)).toBe(false);
    });

    it('a multi-line selection (a drag) is not a prefix hit', () => {
        expect(mouseSelectionInPrefix(0, 3, 1, 2, 6)).toBe(false);
    });

    it('holds across marker shapes — interior in prefix, content out', () => {
        for (const line of ['- [ ] a', '- [x] a', '- [/] a', '- [>] a', '- [!] a']) {
            const cs = contentStart(line); // 6 for every single-char marker
            expect(mouseSelectionInPrefix(0, 3, 0, 4, cs)).toBe(true); // marker interior
            expect(mouseSelectionInPrefix(0, cs, 0, cs + 1, cs)).toBe(false); // content
        }
    });
});
