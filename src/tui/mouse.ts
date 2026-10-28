/**
 * Mouse reports, ours: SGR-1006 sequences (`ESC [ < b ; x ; y M|m`) read off
 * the same stdin chunks Ink reads (a `'data'` listener beside Ink's
 * `'readable'` one sees every chunk Ink reads). npm has no maintained
 * standalone parser, and every comparable JavaScript TUI — Claude Code,
 * Gemini CLI, OpenTUI — writes this one. Ink 8 already drops
 * these sequences before `useInput`, whole or split across reads.
 */

import { onExit } from 'signal-exit';

/**
 * Modes 1000 (press and release), 1002 (motion while a button is held, for
 * dragging the detail pane's edge) and 1006 (SGR coordinates) — never 1003,
 * motion with no button, which would report every move across the pane.
 */
export const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

/**
 * Mouse reporting on until the returned function, or the process's end —
 * however it ends: a quit, a crash, or a signal (`signal-exit`, which Ink
 * restores the screen with too). Left on, the shell the pane falls back to
 * would get every click as typed text.
 */
export function mouseReporting(out: { write(s: string): unknown }): () => void {
    out.write(MOUSE_ON);
    let on = true;
    const off = () => {
        if (on) out.write(MOUSE_OFF);
        on = false;
    };
    const unhook = onExit(off);
    return () => {
        off();
        unhook();
    };
}

export interface MouseEvent {
    /** `drag`: the pointer moved with `button` held down. */
    readonly kind: 'press' | 'release' | 'drag' | 'wheel';
    /** 0 left, 1 middle, 2 right; for the wheel, -1 up and 1 down. */
    readonly button: number;
    /** 0-based column and row. */
    readonly x: number;
    readonly y: number;
    readonly shift: boolean;
    readonly alt: boolean;
    readonly ctrl: boolean;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: mouse reports start with ESC.
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** What a report cut off at the end of a read can look like so far. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: mouse reports start with ESC.
const PARTIAL = /\x1b(?:\[(?:<[\d;]*)?)?$/;

function decode(b: number, x: number, y: number, final: string): MouseEvent | undefined {
    const mods = { x: x - 1, y: y - 1, shift: (b & 4) > 0, alt: (b & 8) > 0, ctrl: (b & 16) > 0 };
    if (b & 32) {
        // Motion: with a button held (1002) a drag; with none (1003, never asked for) nothing.
        const low = b & 3;
        return low < 3 && !(b & 64) ? { kind: 'drag', button: low, ...mods } : undefined;
    }
    if (b & 64) {
        const low = b & 3;
        return low < 2 ? { kind: 'wheel', button: low === 0 ? -1 : 1, ...mods } : undefined;
    }
    return { kind: final === 'M' ? 'press' : 'release', button: b & 3, ...mods };
}

/** A report or a key's sequence cut off at the end of a read — not a lone ESC, which is the Esc key. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: mouse reports start with ESC.
const PARTIAL_REPORT = /\x1b\[[<\d;:]*$/;

/**
 * A chunk with its mouse reports taken out, for a reader that wants only the
 * keys (the note's editor would type a report's tail as text). A report,
 * or any other CSI sequence, cut off at the end comes back as `held`, to go
 * in front of the next chunk.
 */
export function withoutMouseReports(chunk: string): { keys: string; held: string } {
    const keys = chunk.replace(SGR, '');
    const tail = PARTIAL_REPORT.exec(keys);
    return tail ? { keys: keys.slice(0, tail.index), held: tail[0] } : { keys, held: '' };
}

/** A parser for one stream: feed it each chunk read; a report split across reads comes out whole. */
export function mouseParser(): (chunk: string) => MouseEvent[] {
    let pending = '';
    return (chunk) => {
        const input = pending + chunk;
        const events: MouseEvent[] = [];
        let end = 0;
        for (const m of input.matchAll(SGR)) {
            const e = decode(Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? 'M');
            if (e) events.push(e);
            end = m.index + m[0].length;
        }
        const tail = PARTIAL.exec(input.slice(end));
        pending = tail && tail[0].length <= 32 ? tail[0] : '';
        return events;
    };
}
