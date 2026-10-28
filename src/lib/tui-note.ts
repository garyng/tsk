import stringWidth from 'string-width';

/**
 * The note `S` asks for, pure: what Esc does, and how its lines wrap into
 * the footer's rows.
 */

/** A second Esc within this clears the note: Claude Code's double-press window (2.1.296). */
export const ESC_AGAIN_MS = 800;

/**
 * Esc on the note, as Claude Code's prompt does it: on an empty note it
 * cancels; on a note with text the first press arms (the footer says "esc
 * again to clear") and a second within {@link ESC_AGAIN_MS} clears.
 */
export function noteEscape(
    text: string,
    armedAt: number | undefined,
    now: number,
): 'cancel' | 'arm' | 'clear' {
    if (text === '') return 'cancel';
    return armedAt !== undefined && now - armedAt <= ESC_AGAIN_MS ? 'clear' : 'arm';
}

/** A screen row of the note: the line it shows, and which part (UTF-16 offsets, `end` exclusive). */
export interface NoteRow {
    readonly line: number;
    readonly start: number;
    readonly end: number;
}

/**
 * The note's lines wrapped into screen rows, the first row `first` columns
 * wide and the rest `rest`: at a space where there is one (the space stays at
 * the end of its row), else mid-word. Ours, not `wrap-ansi`'s (already a
 * dependency): that returns the wrapped text, not where each row starts in the
 * line, which the cursor needs.
 */
export function noteRows(lines: readonly string[], first: number, rest: number): NoteRow[] {
    const rows: NoteRow[] = [];
    lines.forEach((text, line) => {
        let start = 0;
        let width = 0;
        /** Just after the row's last space, where it can break. */
        let space = -1;
        let i = 0;
        for (const ch of text) {
            const w = stringWidth(ch);
            const room = Math.max(1, rows.length === 0 ? first : rest);
            if (width + w > room && i > start) {
                if (ch === ' ') {
                    // A space that doesn't fit ends its row, unseen past the edge.
                    rows.push({ line, start, end: i + 1 });
                    start = i + 1;
                    width = 0;
                    space = -1;
                    i += ch.length;
                    continue;
                }
                if (space > start) {
                    rows.push({ line, start, end: space });
                    width = stringWidth(text.slice(space, i));
                    start = space;
                } else {
                    rows.push({ line, start, end: i });
                    start = i;
                    width = 0;
                }
                space = -1;
            }
            width += w;
            i += ch.length;
            if (ch === ' ') space = i;
        }
        rows.push({ line, start, end: text.length });
    });
    return rows;
}

/** The row the cursor shows on: at a wrap, the start of the next row rather than past the end of this one. */
export function cursorRow(rows: readonly NoteRow[], line: number, cursor: number): number {
    for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if (!row || row.line !== line || cursor < row.start) continue;
        if (cursor < row.end || rows[r + 1]?.line !== line) return r;
    }
    return 0;
}

/**
 * Where up (`-1`) or down (`1`) takes the cursor: the row above or below on
 * screen, at the same column as far as that row goes, whether it's the same
 * line wrapped or another; undefined at the first or last row. `indent` is
 * where row `r` starts on screen.
 */
export function verticalMove(
    rows: readonly NoteRow[],
    lines: readonly string[],
    line: number,
    cursor: number,
    dir: -1 | 1,
    indent: (r: number) => number,
): { line: number; cursor: number } | undefined {
    const r = cursorRow(rows, line, cursor);
    const from = rows[r];
    const to = rows[r + dir];
    if (!from || !to) return undefined;
    const x = indent(r) + stringWidth((lines[from.line] ?? '').slice(from.start, cursor));
    // A wrapped row's end is the next row's start: the cursor can't sit on it here.
    const wrapped = rows[r + dir + 1]?.line === to.line;
    let at = to.start;
    let column = indent(r + dir);
    for (const ch of (lines[to.line] ?? '').slice(to.start, to.end)) {
        const w = stringWidth(ch);
        if (column + w > x || (wrapped && at + ch.length >= to.end)) break;
        column += w;
        at += ch.length;
    }
    return { line: to.line, cursor: at };
}
