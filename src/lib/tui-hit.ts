import stringWidth from 'string-width';
import type { ListWindow } from './tui-layout';

/**
 * What a mouse click lands on in the `tsk` TUI, pure: the screen as the app
 * lays it out — the tab strip on the first line, a rule, the breadcrumb when
 * there is one, the list windowed by the same row heights the app draws
 * with, the detail pane's edge, and the footer bar's rows at the bottom.
 */

export type HitTarget =
    | { readonly kind: 'tab'; readonly index: number }
    /** The deps drill-down's `esc back`. */
    | { readonly kind: 'back' }
    /** A label of the breadcrumb, by its index in the path. */
    | { readonly kind: 'crumb'; readonly index: number }
    /** A line of the list, by its index in the list (a task, or a heading). */
    | { readonly kind: 'row'; readonly index: number }
    | { readonly kind: 'more'; readonly direction: -1 | 1 }
    /** The list's area with nothing on it, or the `?` overlay over it. */
    | { readonly kind: 'list' }
    /** The detail pane's edge, which a drag moves. */
    | { readonly kind: 'divider' }
    /** The footer bar, by its row (from its top) and column: its hints are clickable. */
    | { readonly kind: 'footer'; readonly row: number; readonly x: number };

/** Columns `from` (inclusive) to `to` (exclusive) of a line, and what they are. */
export interface Zone {
    readonly from: number;
    readonly to: number;
    readonly target: HitTarget;
}

export interface ScreenMap {
    /** Zones of the tab strip, on line 0. */
    readonly strip: readonly Zone[];
    /** Zones of the breadcrumb, on line 2, when it shows. */
    readonly crumbs?: readonly Zone[];
    readonly listTop: number;
    readonly listHeight: number;
    /** The list's window; undefined while something else (the `?` overlay) covers the list. */
    readonly window?: ListWindow;
    /** Each list line's height in screen lines. */
    readonly heights: readonly number[];
    /** The footer's first line; it runs to the last. */
    readonly footerY: number;
    /**
     * The detail pane's edge, when it shows: beside the list, its border on
     * column `at` of every line between the rule and the footer; stacked, its
     * top rule on line `at`.
     */
    readonly divider?: { readonly side: boolean; readonly at: number };
}

/** Pieces laid end to end from column 0, as zones for the ones with a target. */
export function zones(pieces: readonly { text: string; target?: HitTarget }[]): Zone[] {
    const out: Zone[] = [];
    let at = 0;
    for (const p of pieces) {
        const w = stringWidth(p.text);
        if (p.target) out.push({ from: at, to: at + w, target: p.target });
        at += w;
    }
    return out;
}

export function hitTest(map: ScreenMap, x: number, y: number): HitTarget | undefined {
    const zoneAt = (zs: readonly Zone[]) => zs.find((z) => x >= z.from && x < z.to)?.target;
    if (y === 0) return zoneAt(map.strip);
    if (y >= map.footerY) return { kind: 'footer', row: y - map.footerY, x };
    const d = map.divider;
    if (d && (d.side ? x === d.at && y >= 2 && y < map.footerY : y === d.at)) {
        return { kind: 'divider' };
    }
    if (map.crumbs && y === 2) return zoneAt(map.crumbs);
    const line = y - map.listTop;
    if (line < 0 || line >= map.listHeight) return undefined;
    const w = map.window;
    if (!w) return { kind: 'list' };
    let at = 0;
    if (w.above > 0) {
        if (line === 0) return { kind: 'more', direction: -1 };
        at = 1;
    }
    for (let i = w.top; i < w.end; i++) {
        at += map.heights[i] ?? 1;
        if (line < at) return { kind: 'row', index: i };
    }
    if (w.below > 0 && line === at) return { kind: 'more', direction: 1 };
    return { kind: 'list' };
}
