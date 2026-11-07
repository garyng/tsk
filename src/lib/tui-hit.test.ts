import { describe, expect, it } from 'vitest';
import { hitTest, type ScreenMap, zones } from './tui-hit';
import { listWindow } from './tui-layout';

describe('zones', () => {
    it('lays pieces end to end by their width, keeping only those with a target', () => {
        expect(
            zones([
                { text: ' tsk ' },
                { text: ' Session ', target: { kind: 'tab', index: 0 } },
                { text: ' Tree ', target: { kind: 'tab', index: 1 } },
            ]),
        ).toEqual([
            { from: 5, to: 14, target: { kind: 'tab', index: 0 } },
            { from: 14, to: 20, target: { kind: 'tab', index: 1 } },
        ]);
    });
});

describe('hitTest', () => {
    // Rows of 1, 2 and 3 lines, then more; a 6-line list from line 3 (under crumbs), footer on 10.
    const heights = [1, 2, 3, 1, 1, 1];
    const map = (top = 0): ScreenMap => ({
        strip: zones([{ text: ' tsk ' }, { text: ' Session ', target: { kind: 'tab', index: 0 } }]),
        crumbs: zones([
            { text: 'plan', target: { kind: 'crumb', index: 0 } },
            { text: ' › ' },
            { text: 'phase', target: { kind: 'crumb', index: 1 } },
        ]),
        listTop: 3,
        listHeight: 6,
        window: listWindow(heights, top, top, 6),
        heights,
        footerY: 10,
    });

    it('finds the tab, the crumb, and the footer by its row and column', () => {
        expect(hitTest(map(), 6, 0)).toEqual({ kind: 'tab', index: 0 });
        expect(hitTest(map(), 2, 0)).toBeUndefined();
        expect(hitTest(map(), 8, 2)).toEqual({ kind: 'crumb', index: 1 });
        expect(hitTest(map(), 5, 2)).toBeUndefined(); // the separator
        expect(hitTest(map(), 4, 10)).toEqual({ kind: 'footer', row: 0, x: 4 });
        expect(hitTest({ ...map(), footerY: 9 }, 4, 10)).toEqual({ kind: 'footer', row: 1, x: 4 });
    });

    it('finds a row by its lines, a wrapped row on any of them', () => {
        expect(hitTest(map(), 0, 3)).toEqual({ kind: 'row', index: 0 });
        expect(hitTest(map(), 0, 5)).toEqual({ kind: 'row', index: 1 }); // its second line
    });

    it('finds the "more" lines, scrolled in from either end', () => {
        // From the top: rows 0–1 take 3 lines; row 2 (3 more) leaves no line for "↓ N more", which comes next.
        expect(hitTest(map(), 0, 3 + 3)).toEqual({ kind: 'more', direction: 1 });
        const scrolled = map(4);
        expect(scrolled.window?.top).toBeGreaterThan(0);
        expect(hitTest(scrolled, 0, 3)).toEqual({ kind: 'more', direction: -1 });
    });

    it("finds the detail pane's edge: its top rule stacked, its border column beside", () => {
        // Stacked, the pane starts on the line after the list's last (3 + 6).
        const stacked = { ...map(), divider: { side: false, at: 9 } };
        expect(hitTest(stacked, 30, 9)).toEqual({ kind: 'divider' });
        expect(hitTest(stacked, 30, 3)).toEqual({ kind: 'row', index: 0 });
        const beside = { ...map(), divider: { side: true, at: 40 } };
        expect(hitTest(beside, 40, 2)).toEqual({ kind: 'divider' });
        expect(hitTest(beside, 40, 9)).toEqual({ kind: 'divider' });
        expect(hitTest(beside, 40, 0)).toBeUndefined(); // the strip has nothing there
        expect(hitTest(beside, 40, 10)).toEqual({ kind: 'footer', row: 0, x: 40 });
    });

    it('is the list itself under the overlay, and nothing outside the screen parts', () => {
        expect(hitTest({ ...map(), window: undefined }, 0, 4)).toEqual({ kind: 'list' });
        expect(hitTest(map(), 0, 1)).toBeUndefined(); // the rule
    });
});
