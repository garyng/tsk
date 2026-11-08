import * as vscode from 'vscode';
import type { Category, LinkStatus } from './lib/link-status/status';

/**
 * How a link's status is drawn: a rounded chip after the link, tinted in its
 * category's colour.
 *
 * VS Code draws an extension's decoration text with CSS, outside the line's
 * text, and doesn't count it when it wraps a line: a chip drawn that way makes
 * a wrapped line overflow. An inlay hint is part of the line's text. So the
 * chip floats over a blank inlay hint as wide as it ({@link reserve}): the
 * hint takes the room and the clicks, and the chip goes wherever the hint goes.
 * Without hints that match the editor's font ({@link inlayHintsReserve}), the
 * chip sits in the line instead ({@link INLINE}), and a long line overflows.
 */

const NB = ' ';
export const CHECKS_GLYPH = { passing: '✓', failing: '✗', pending: '○' } as const;

/** The chip's text: the label and the checks glyph, a space of room each side. */
export function chipText(s: LinkStatus): string {
    return `${NB}${s.checks ? `${s.label} ${CHECKS_GLYPH[s.checks]}` : s.label}${NB}`;
}

/** The blank inlay hint the floating chip covers: a space before it, then its width. */
export function reserve(s: LinkStatus): string {
    return NB.repeat(chipText(s).length + 1);
}

// The API has no border-radius, position or pointer-events for decoration text. VS Code writes
// `textDecoration` into the CSS as it is (`text-decoration:{0};`, checked in 1.145), so they ride
// along after it. A VS Code that stopped that would draw square chips in the line's flow.
const css = (...declarations: string[]) => `none; ${declarations.join('; ')}`;
const ROUND = 'border-radius: 0.35em';

/**
 * Over the blank hint, out of the line's flow, clicks through to the hint. On the empty
 * range at the link's end, which VS Code places after the hint there (checked in 1.145), so a
 * negative margin as wide as the chip pulls it back over the blank.
 */
export const FLOATING: vscode.DecorationRenderOptions = {
    before: { textDecoration: css('position: absolute', 'pointer-events: none', ROUND) },
};
/** In the line, on the empty range at the link's end: a space, then the chip. */
export const INLINE: vscode.DecorationRenderOptions = {
    before: { contentText: NB },
    after: { textDecoration: css(ROUND) },
};

const color = (c: Category) => new vscode.ThemeColor(`tsk.linkStatus.${c.toLowerCase()}`);
/**
 * The category's colour at 18% over the editor's background, opaque: the floating chip covers
 * the hint, whose own background would show through a translucent one. VS Code names a theme
 * colour's CSS variable after its id.
 */
const tint = (c: Category) =>
    `color-mix(in srgb, var(--vscode-tsk-linkStatus-${c.toLowerCase()}) 18%, var(--vscode-editor-background))`;

export function floatingOptions(s: LinkStatus): vscode.DecorationInstanceRenderOptions {
    const text = chipText(s);
    return {
        before: {
            contentText: text,
            margin: `0 0 0 -${text.length}ch`,
            color: color(s.category),
            backgroundColor: tint(s.category),
        },
    };
}

export function inlineOptions(s: LinkStatus): vscode.DecorationInstanceRenderOptions {
    return {
        after: {
            contentText: chipText(s),
            color: color(s.category),
            backgroundColor: tint(s.category),
        },
    };
}

/**
 * Whether inlay hints can hold the floating chip's room in `document`'s editor: always shown,
 * no padding, and in the editor's own font and size (VS Code's `_getLayoutInfo`: a hint font
 * size under 5 or over the editor's is the editor's). Else the blank and the chip differ in
 * width, or the blank goes while the chip stays.
 */
export function inlayHintsReserve(document: vscode.TextDocument): boolean {
    const editor = vscode.workspace.getConfiguration('editor', document);
    const size = editor.get<number>('inlayHints.fontSize') ?? 0;
    const family = editor.get<string>('inlayHints.fontFamily') ?? '';
    return (
        editor.get<string>('inlayHints.enabled') === 'on' &&
        editor.get<boolean>('inlayHints.padding') !== true &&
        (family === '' || family === editor.get<string>('fontFamily')) &&
        (size < 5 || size >= (editor.get<number>('fontSize') ?? 0))
    );
}
