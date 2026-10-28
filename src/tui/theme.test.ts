import { describe, expect, it } from 'vitest';
import { makeTheme, mix } from './theme';

describe('mix', () => {
    it('blends two colours channel by channel', () => {
        expect(mix('#ffffff', '#000000', 0.5)).toBe('#808080');
        expect(mix('#3794ff', '#1e1e1e', 0)).toBe('#1e1e1e');
        expect(mix('#3794ff', '#1e1e1e', 1)).toBe('#3794ff');
    });
});

describe('makeTheme', () => {
    it("tints the selection with a fifth of the accent over the terminal's own background", () => {
        expect(makeTheme(true, { background: '#1e1e1e', dark: true }).selectedRow).toEqual({
            backgroundColor: '#23364b',
        });
        expect(makeTheme(true, { background: '#ffffff', dark: false }).selectedRow).toEqual({
            backgroundColor: '#d1e4f6',
        });
    });
    it("undims the selected row's text, so a finished task reads under the tint", () => {
        const t = makeTheme(true);
        expect(t.text.completed.dimColor).toBe(true);
        expect({ ...t.text.completed, ...t.selected }.dimColor).toBe(false);
    });
    it("uses the extension's light or dark marker colours to match the terminal", () => {
        expect(makeTheme(true, { dark: true }).glyph.completed.color).toBe('#67c23a');
        expect(makeTheme(true, { dark: false }).glyph.completed.color).toBe('#388e3c');
    });
    it('colours only the states that need it: an open task takes the text colour', () => {
        const t = makeTheme(true);
        expect(t.glyph.todo).toEqual({});
        expect(t.glyph.inprogress).toEqual({ color: '#3794ff', bold: true });
    });
    it("picks out the cursor in the footer's list of states with the selection's tint, not the bar's grey", () => {
        const t = makeTheme(true);
        expect(t.cursor.backgroundColor).toBe(t.selectedRow.backgroundColor);
        expect(t.cursor.backgroundColor).not.toBe(t.bar.backgroundColor);
        expect(makeTheme(false).cursor.inverse).toBe(true);
    });
    it('uses no colour at all without it, and shows the selection in reverse instead', () => {
        const t = makeTheme(false);
        const styles = [
            ...Object.values(t.glyph),
            ...Object.values(t.text),
            ...Object.values(t.tone),
            t.selectedRow,
            t.selected,
            t.cursor,
            t.activeTab,
            t.rule,
            t.bar,
            t.key,
        ];
        expect(styles.filter((s) => s.color || s.backgroundColor)).toEqual([]);
        expect(t.selected.inverse).toBe(true);
    });
});
