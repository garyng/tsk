import { describe, expect, it } from 'vitest';
import {
    HELP_KEYS_WIDTH,
    type Hint,
    helpLines,
    hintsFor,
    KEY_GROUPS,
    KEY_TABLE,
    keysToActions,
    type TuiAction,
    wrapHints,
} from './tui-keys';

describe('keysToActions', () => {
    it('turns every character of a batched read into its own action', () => {
        expect(keysToActions('jjjjj', {})).toEqual(['down', 'down', 'down', 'down', 'down']);
        expect(keysToActions('jjk', {})).toEqual(['down', 'down', 'up']);
    });

    it('ignores characters with no binding', () => {
        expect(keysToActions('wjw', {})).toEqual(['down']);
    });

    it('reads the special keys from the flags', () => {
        expect(keysToActions('', { downArrow: true })).toEqual(['down']);
        expect(keysToActions('', { return: true })).toEqual(['zoomIn']);
        expect(keysToActions('', { backspace: true })).toEqual(['zoomOut']);
        expect(keysToActions('', { escape: true })).toEqual(['escape']);
        expect(keysToActions('', { tab: true })).toEqual(['switchView']);
        expect(keysToActions('c', { ctrl: true })).toEqual(['quit']);
    });

    it('reads tab and enter inside a batched read as characters', () => {
        expect(keysToActions('g\r', {})).toEqual(['top', 'zoomIn']);
        expect(keysToActions('\tj', {})).toEqual(['switchView', 'down']);
    });

    it('maps d to the dependency view', () => {
        expect(keysToActions('d', {})).toEqual(['deps']);
    });

    it('jumps to a view by its tab number, and goes back a view on shift-tab', () => {
        expect(keysToActions('123', {})).toEqual(['sessionView', 'treeView', 'stepsView']);
        expect(keysToActions('', { tab: true, shift: true })).toEqual(['prevView']);
    });

    it('maps m to a message, s to a switch, and nothing to the keys that used to change a task', () => {
        expect(keysToActions('s', {})).toEqual(['switch']);
        expect(keysToActions('mv', {})).toEqual(['message', 'mark']);
        expect(keysToActions('Scx', {})).toEqual([]);
    });

    it('maps the detail pane: p shows it, J/K and PgDn/PgUp scroll it, o opens its file', () => {
        expect(keysToActions('pJKo', {})).toEqual(['detail', 'detailDown', 'detailUp', 'openFile']);
        expect(keysToActions('', { pageDown: true })).toEqual(['detailPageDown']);
        expect(keysToActions('', { pageUp: true })).toEqual(['detailPageUp']);
    });

    it('folds on space, and folds or unfolds everything on z and Z', () => {
        expect(keysToActions(' zZ', {})).toEqual(['fold', 'foldAll', 'unfoldAll']);
    });

    it('filters on /, and keeps Esc apart from u and h, as it clears a filter first', () => {
        expect(keysToActions('/', {})).toEqual(['filter']);
        expect(keysToActions('uh', {})).toEqual(['zoomOut', 'zoomOut']);
    });

    it('resizes the detail pane: + grows it, - shrinks it, = puts it back', () => {
        expect(keysToActions('+-=', {})).toEqual(['detailGrow', 'detailShrink', 'detailReset']);
    });
});

describe('the key table', () => {
    const ALL_ACTIONS: readonly TuiAction[] = [
        'down',
        'up',
        'top',
        'bottom',
        'quit',
        'switchView',
        'prevView',
        'sessionView',
        'treeView',
        'stepsView',
        'zoomIn',
        'zoomOut',
        'escape',
        'message',
        'mark',
        'open',
        'switch',
        'states',
        'fold',
        'foldAll',
        'unfoldAll',
        'filter',
        'deps',
        'help',
        'detail',
        'detailDown',
        'detailUp',
        'detailPageDown',
        'detailPageUp',
        'detailGrow',
        'detailShrink',
        'detailReset',
        'openFile',
    ];

    it('documents every action: each one is bound in a row the ? overlay shows', () => {
        const bound = new Set(KEY_TABLE.flatMap((r) => r.bind.map((b) => b.action)));
        expect([...bound].sort()).toEqual([...ALL_ACTIONS].sort());
        const shown = helpLines().flatMap((l) => (l.kind === 'key' ? [l.keys] : []));
        expect(shown).toEqual(KEY_TABLE.map((r) => r.keys));
    });

    it('binds each character to one action only', () => {
        const chars = KEY_TABLE.flatMap((r) => r.bind.flatMap((b) => b.chars ?? []));
        expect(new Set(chars).size).toBe(chars.length);
    });

    it('names, in every hint, a key its row binds', () => {
        for (const r of KEY_TABLE) {
            const keys = r.hint?.keys;
            if (keys === undefined) continue;
            // The footer's short form for a special key: ⏎ is enter, esc is escape.
            const special: Record<string, string> = { '⏎': 'enter', esc: 'esc' };
            expect(r.keys).toContain(special[keys] ?? keys);
        }
    });
});

describe('hintsFor', () => {
    const show = (hints: Hint[]) => hints.map((h) => `${h.keys} ${h.label}`);

    it('offers the keys for the selected task, ? keys last, and none that changes it', () => {
        expect(show(hintsFor({ view: 'session', marker: 'todo' }))).toEqual([
            'd deps',
            '⏎ zoom',
            'e open',
            '? keys',
        ]);
    });

    it('offers m first when a session is followed, whatever the state', () => {
        for (const marker of ['todo', 'inprogress', 'completed', 'cancelled'] as const)
            expect(show(hintsFor({ view: 'session', marker, canTell: true }))).toEqual([
                'm message',
                'd deps',
                '⏎ zoom',
                'e open',
                'v mark',
                '? keys',
            ]);
        expect(show(hintsFor({ view: 'session', canTell: true }))).toEqual(['? keys']);
    });

    it('offers esc close first while the keys are shown', () => {
        expect(show(hintsFor({ view: 'session', help: true }))).toEqual(['esc close', '? keys']);
        expect(show(hintsFor({ view: 'tree', help: true, marks: 2, filtered: true }))[0]).toBe(
            'esc close',
        );
    });

    it('offers no zoom into a task from another file, which the tree has no place for', () => {
        expect(
            show(hintsFor({ view: 'deps', marker: 'todo', canTell: true, outside: true })),
        ).toEqual(['esc back', 'm message', 'd deps', 'e open', 'v mark', '? keys']);
    });

    it('offers v unmark on a marked task, and esc unmark all first while any is marked', () => {
        const ctx = { view: 'tree' as const, marker: 'todo' as const, canTell: true };
        expect(show(hintsFor({ ...ctx, marked: true, marks: 2 }))).toContain('v unmark');
        expect(show(hintsFor({ ...ctx, marks: 2, filtered: true }))[0]).toBe('esc unmark all');
        expect(show(hintsFor(ctx))).not.toContain('esc unmark all');
    });

    it("offers s switch on another session's task, after e open", () => {
        const ctx = { view: 'layers' as const, marker: 'todo' as const };
        const shown = show(hintsFor({ ...ctx, canSwitch: true }));
        expect(shown.indexOf('s switch')).toBe(shown.indexOf('e open') + 1);
        expect(show(hintsFor(ctx))).not.toContain('s switch');
        expect(show(hintsFor({ view: 'layers', canSwitch: true }))).not.toContain('s switch');
    });

    it('offers only ? keys when nothing is selected', () => {
        expect(show(hintsFor({ view: 'session' }))).toEqual(['? keys']);
    });

    it('puts the way back first in the dependency view and when zoomed', () => {
        expect(show(hintsFor({ view: 'deps', marker: 'todo' }))[0]).toBe('esc back');
        expect(show(hintsFor({ view: 'tree', marker: 'todo', zoomed: true }))[0]).toBe('esc out');
        expect(show(hintsFor({ view: 'tree', marker: 'todo' }))).not.toContain('esc out');
    });

    it('offers folding in the tree view, as the selected task reads now', () => {
        expect(show(hintsFor({ view: 'tree', marker: 'todo' }))).toContain('space fold');
        expect(show(hintsFor({ view: 'tree', marker: 'todo', folded: true }))).toContain(
            'space unfold',
        );
        expect(show(hintsFor({ view: 'session', marker: 'todo' }))).not.toContain('space fold');
        expect(show(hintsFor({ view: 'tree' }))).not.toContain('space fold');
    });

    it('offers / in the tree view, Esc to clear a kept filter first, and no folding meanwhile', () => {
        const tree = show(hintsFor({ view: 'tree', marker: 'todo' }));
        expect(tree).toContain('/ filter');
        expect(tree.indexOf('/ filter')).toBe(tree.indexOf('⏎ zoom') + 1);
        expect(show(hintsFor({ view: 'session', marker: 'todo' }))).not.toContain('/ filter');
        const filtered = show(hintsFor({ view: 'tree', marker: 'todo', filtered: true }));
        expect(filtered[0]).toBe('esc clear');
        expect(filtered).not.toContain('space fold');
        expect(
            show(hintsFor({ view: 'tree', marker: 'todo', filtered: true, zoomed: true }))[0],
        ).toBe('esc clear');
    });

    it('offers the list of states in the tree view', () => {
        expect(show(hintsFor({ view: 'tree', marker: 'todo' }))).toContain('a states');
        expect(show(hintsFor({ view: 'session', marker: 'todo' }))).not.toContain('a states');
    });
});

describe('wrapHints', () => {
    const hints = hintsFor({ view: 'session', marker: 'todo', canTell: true });
    const keys = (rows: Hint[][]) => rows.map((r) => r.map((h) => h.keys));

    it('keeps them on one row when they fit', () => {
        expect(wrapHints(hints, 200)).toEqual([hints]);
    });

    it('wraps whole hints, in order, ? keys last', () => {
        // ' m message ' 11, ' d deps ' 8, ' ⏎ zoom ' 8, ' e open ' 8, ' v mark ' 8, ' ? keys ' 8
        expect(keys(wrapHints(hints, 27))).toEqual([
            ['m', 'd', '⏎'],
            ['e', 'v', '?'],
        ]);
        expect(keys(wrapHints(hints, 26))).toEqual([['m', 'd'], ['⏎', 'e', 'v'], ['?']]);
    });

    it('leaves room on the first row for what sits on its right', () => {
        expect(keys(wrapHints(hints, 27, 19))).toEqual([['m', 'd'], ['⏎', 'e', 'v'], ['?']]);
    });

    it('puts a hint wider than the row on a row of its own', () => {
        expect(keys(wrapHints(hints, 3))).toEqual(hints.map((h) => [h.keys]));
    });
});

describe('helpLines', () => {
    it('groups the keys under a heading each, in order, leaving out empty groups', () => {
        const groups = helpLines().flatMap((l) => (l.kind === 'group' ? [l.text] : []));
        expect(groups).toEqual(KEY_GROUPS.filter((g) => KEY_TABLE.some((r) => r.group === g)));
        expect(helpLines()[0]).toEqual({ kind: 'group', text: 'move' });
    });

    it('leaves room for the widest keys', () => {
        expect(HELP_KEYS_WIDTH).toBe('q ctrl+c'.length + 2);
    });
});
