import { describe, expect, it } from 'vitest';
import { panelPlacement, reviseSourceColumn } from './panel-placement';

describe('panelPlacement', () => {
    it('right is a plain Beside — no follow-up command', () => {
        expect(panelPlacement('right')).toEqual({ column: 'beside' });
    });

    it('active opens in the editor’s own group', () => {
        expect(panelPlacement('active')).toEqual({ column: 'active' });
    });

    it('left / above / below create in the ACTIVE group, then split it', () => {
        // The move commands act relative to the ACTIVE group, so the panel
        // has to start in the editor's own group to land relative to the file.
        expect(panelPlacement('left')).toEqual({
            column: 'active',
            moveCommand: 'workbench.action.moveEditorToLeftGroup',
        });
        expect(panelPlacement('above')).toEqual({
            column: 'active',
            moveCommand: 'workbench.action.moveEditorToAboveGroup',
        });
        expect(panelPlacement('below')).toEqual({
            column: 'active',
            moveCommand: 'workbench.action.moveEditorToBelowGroup',
        });
    });

    it('an unknown or empty value falls back to right', () => {
        for (const value of ['', 'sideways', 'RIGHT', 'beside', 'up']) {
            expect(panelPlacement(value)).toEqual({ column: 'beside' });
        }
    });

    it('every documented direction is handled', () => {
        for (const direction of ['right', 'left', 'above', 'below', 'active']) {
            expect(panelPlacement(direction).column).toMatch(/^(beside|active)$/);
        }
    });
});

describe('reviseSourceColumn', () => {
    it('leaves a column that does not collide with the panel', () => {
        expect(reviseSourceColumn(1, 2, [1, 2])).toBe(1);
    });

    it('moves off the panel’s own column, to a visible one', () => {
        // The `above` case: panel lands in group 1, the file is now group 2,
        // but the remembered column was captured as 1 before the panel existed.
        expect(reviseSourceColumn(1, 1, [1, 2])).toBe(2);
    });

    it('falls back to column 1 when nothing else is visible', () => {
        expect(reviseSourceColumn(1, 1, [1])).toBe(1);
        expect(reviseSourceColumn(2, 2, [])).toBe(1);
    });

    it('is a no-op while the panel has no column yet', () => {
        expect(reviseSourceColumn(3, undefined, [1, 2])).toBe(3);
    });
});
