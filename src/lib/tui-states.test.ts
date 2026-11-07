import { describe, expect, it } from 'vitest';
import type { Marker } from './markers';
import {
    OPEN_STATES,
    PRESETS,
    presetOf,
    presetRow,
    STATES,
    shownStates,
    stateRow,
    statesGlyphs,
    TICKED,
    UNTICKED,
} from './tui-states';

const text = (ps: { text: string }[]) => ps.map((p) => p.text).join('');

describe('shownStates', () => {
    it('is undefined, every state, when all are ticked, else the ticked ones', () => {
        expect(shownStates(new Set(STATES))).toBeUndefined();
        expect(shownStates(OPEN_STATES)).toBe(OPEN_STATES);
    });
});

describe('statesGlyphs', () => {
    it('reads the shown states as their glyphs, in the list order', () => {
        expect(statesGlyphs(new Set<Marker>(['inprogress', 'todo']))).toBe('○◐');
    });
});

describe('the checkboxes', () => {
    it('have no emoji form: a terminal whose font lacks one draws it in colour (☑ did, in Windows Terminal)', () => {
        expect(`${TICKED}${UNTICKED}`).not.toMatch(/\p{Emoji}/u);
    });
});

describe('stateRow', () => {
    it('names each state with its checkbox and glyph, the cursor picked out, the hint on the right', () => {
        const row = stateRow(OPEN_STATES, 2, 120);
        expect(text(row)).toMatch(
            /^ show {2}■ ○ todo {2}■ ◐ in progress {2}□ ✓ done {2}□ ✕ cancelled {2}□ → moved {2}□ • note +space tick · ⏎ keep · esc $/,
        );
        expect(text(row).length).toBe(120);
        expect(row.filter((p) => p.tone === 'current').map((p) => p.text)).toEqual(['□ ✓ done']);
    });

    it("drops the names in a narrow pane, naming only the cursor's", () => {
        const row = stateRow(OPEN_STATES, 1, 64);
        expect(text(row)).toMatch(/^ show {2}■○ ■◐ □✓ □✕ □→ □• {2}in progress {2,}⏎ keep · esc $/);
        expect(text(stateRow(OPEN_STATES, 1, 64)).length).toBe(64);
        expect(text(stateRow(OPEN_STATES, 0, 40))).toBe(' show  ■○ ■◐ □✓ □✕ □→ □•  todo');
    });
});

describe('the presets', () => {
    it('each start with their key, no two the same', () => {
        for (const p of PRESETS) expect(p.label.startsWith(p.key)).toBe(true);
        expect(new Set(PRESETS.map((p) => p.key)).size).toBe(PRESETS.length);
    });

    it('put the cursor on the set in view, or on pick… when none is it', () => {
        const label = (states: ReadonlySet<Marker> | undefined) => PRESETS[presetOf(states)]?.label;
        expect(label(new Set<Marker>(['inprogress', 'todo']))).toBe('open');
        expect(label(new Set<Marker>(['moved', 'completed', 'cancelled']))).toBe('closed');
        expect(label(undefined)).toBe('all');
        expect(label(new Set<Marker>(['todo']))).toBe('pick…');
    });
});

describe('presetRow', () => {
    it('names each preset, its first letter a key, the cursor picked out, the hint on the right', () => {
        const row = presetRow(1, 80);
        expect(text(row)).toMatch(
            /^ show {2}open {2}in progress {2}closed {2}all {2}pick… +⏎ keep · esc $/,
        );
        expect(text(row).length).toBe(80);
        expect(row.filter((p) => p.tone === 'current').map((p) => p.text)).toEqual(['in progress']);
        expect(row.filter((p) => p.tone === 'key').map((p) => p.text)).toEqual([
            'o',
            'c',
            'a',
            'p',
        ]);
    });

    it('takes the short hint, then drops it, then shows the letters alone', () => {
        expect(text(presetRow(0, 54))).toMatch(/^ show {2}open .* pick… +⏎ · esc $/);
        expect(text(presetRow(0, 44))).toBe(' show  open  in progress  closed  all  pick…');
        expect(text(presetRow(3, 40))).toMatch(/^ show {2}o i c a p {2}all +⏎ keep · esc $/);
        expect(text(presetRow(3, 32))).toMatch(/^ show {2}o i c a p {2}all +⏎ · esc $/);
        expect(text(presetRow(3, 22))).toBe(' show  o i c a p  all');
    });
});
