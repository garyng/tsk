import { describe, expect, it } from 'vitest';
import type { Marker } from './markers';
import {
    OPEN_STATES,
    PRESETS,
    presetOf,
    presetRows,
    STATES,
    shownStates,
    stateRows,
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

describe('stateRows', () => {
    it('names each state with its checkbox and glyph, the cursor picked out, the hint on the right', () => {
        const rows = stateRows(OPEN_STATES, 2, 120);
        expect(rows.map(text)).toHaveLength(1);
        expect(text(rows[0] ?? [])).toMatch(
            /^ show {2}■ ○ todo {2}■ ◐ in progress {2}□ ✓ done {2}□ ✕ cancelled {2}□ → moved {2}□ • note +space tick · ⏎ keep · esc $/,
        );
        expect(text(rows[0] ?? []).length).toBe(120);
        expect(
            rows
                .flat()
                .filter((p) => p.tone === 'current')
                .map((p) => p.text),
        ).toEqual(['□ ✓ done']);
    });

    it('wraps whole states in a narrow pane, each row after the first under the first state', () => {
        expect(stateRows(OPEN_STATES, 1, 64).map(text)).toEqual([
            ' show  ■ ○ todo  ■ ◐ in progress  □ ✓ done  □ ✕ cancelled',
            `       □ → moved  □ • note${' '.repeat(12)}space tick · ⏎ keep · esc `,
        ]);
    });

    it('puts the hint on a row of its own when the last row has no room for it', () => {
        expect(stateRows(OPEN_STATES, 0, 40).map(text)).toEqual([
            ' show  ■ ○ todo  ■ ◐ in progress',
            '       □ ✓ done  □ ✕ cancelled',
            '       □ → moved  □ • note',
            `${' '.repeat(14)}space tick · ⏎ keep · esc `,
        ]);
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

describe('presetRows', () => {
    it('names each preset, its first letter a key, the cursor picked out, the hint on the right', () => {
        const rows = presetRows(1, 80);
        expect(rows).toHaveLength(1);
        expect(text(rows[0] ?? [])).toMatch(
            /^ show {2}open {2}in progress {2}closed {2}all {2}pick… +⏎ keep · esc $/,
        );
        expect(text(rows[0] ?? []).length).toBe(80);
        const tone = (t: string) =>
            rows
                .flat()
                .filter((p) => p.tone === t)
                .map((p) => p.text);
        expect(tone('current')).toEqual(['in progress']);
        expect(tone('key')).toEqual(['o', 'c', 'a', 'p']);
    });

    it('takes the short hint, then wraps', () => {
        expect(presetRows(0, 54).map(text)).toEqual([
            ' show  open  in progress  closed  all  pick…  ⏎ · esc ',
        ]);
        expect(presetRows(3, 36).map(text)).toEqual([
            ' show  open  in progress  closed',
            '       all  pick…      ⏎ keep · esc ',
        ]);
        expect(presetRows(3, 44).map(text)).toEqual([
            ' show  open  in progress  closed  all  pick…',
            `${' '.repeat(31)}⏎ keep · esc `,
        ]);
    });
});
