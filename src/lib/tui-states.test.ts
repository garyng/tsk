import { describe, expect, it } from 'vitest';
import type { Marker } from './markers';
import {
    OPEN_STATES,
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
