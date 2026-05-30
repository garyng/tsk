import { describe, expect, it } from 'vitest';
import { computeSearchResultRanges } from './search-result-decorations';

// A realistic Search Editor result body: a file header, two match rows with the
// `␣␣<pad><lineNo>:␣` gutter (line numbers right-aligned to width 2 → prefix
// width 6), and a trailing blank. Content columns are shifted +6 onto the rows.
const META1 = '<!-- @id:abc @priority:2 -->';
const META2 = '<!-- @id:def -->';
const SR = ['demo.tsk:', `   9: - [x] done ${META1}`, `  10: - [ ] todo ${META2}`, ''].join('\n');

describe('computeSearchResultRanges', () => {
    it('decorates the marker triplet on each match row, offset by the gutter', () => {
        const { markers } = computeSearchResultRanges(SR);
        // `[x]` in `- [x] done` is at content col 2 → +6 gutter = 8..11 on row 1.
        expect(markers.get('completed')).toEqual([
            { startLine: 1, startCol: 8, endLine: 1, endCol: 11 },
        ]);
        // `[ ]` todo on row 2, same offset.
        expect(markers.get('todo')).toEqual([
            { startLine: 2, startCol: 8, endLine: 2, endCol: 11 },
        ]);
    });

    it('decorates the metadata comment span, offset by the gutter', () => {
        const { metadata } = computeSearchResultRanges(SR);
        // `<!--` starts after `- [x] done ` (11 content chars) → +6 = col 17.
        expect(metadata).toEqual([
            { startLine: 1, startCol: 17, endLine: 1, endCol: 17 + META1.length },
            { startLine: 2, startCol: 17, endLine: 2, endCol: 17 + META2.length },
        ]);
    });

    it('buckets the priority row (whole-line; columns are illustrative)', () => {
        const { priorities } = computeSearchResultRanges(SR);
        const p2 = priorities.get(2);
        expect(p2?.length).toBe(1);
        expect(p2?.[0]?.startLine).toBe(1);
        // todo row has no @priority → no bucket.
        expect(priorities.get(1)).toBeUndefined();
    });

    it('ignores the file-path header and blank lines', () => {
        const { markers, metadata } = computeSearchResultRanges(SR);
        const totalMarkerRanges = [...markers.values()].reduce((n, r) => n + r.length, 0);
        expect(totalMarkerRanges).toBe(2); // only the two match rows
        expect(metadata).toHaveLength(2);
    });

    it('ignores context rows (two-space gutter, no colon) and non-task content', () => {
        const meta = '<!-- @id:z -->';
        const text = [
            'demo.tsk:',
            '  10  - [ ] a context row, not a match', // context gutter `  ` → skipped
            '  11: not a task, just prose', // match row but content isn't a tsk task
            `  12: - [ ] real ${meta}`,
        ].join('\n');
        const { markers, metadata } = computeSearchResultRanges(text);
        // Only row index 3 (`  12: - [ ] real …`) yields decorations.
        expect(markers.get('todo')).toEqual([
            { startLine: 3, startCol: 8, endLine: 3, endCol: 11 },
        ]);
        expect(metadata).toEqual([
            { startLine: 3, startCol: 17, endLine: 3, endCol: 17 + meta.length },
        ]);
    });

    it('returns empty maps for a document with no match rows', () => {
        const { markers, priorities, metadata } = computeSearchResultRanges('demo.tsk:\n\n');
        expect(markers.size).toBe(0);
        expect(priorities.size).toBe(0);
        expect(metadata).toHaveLength(0);
    });
});
