import readline from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { withoutMouseReports } from './mouse';

/**
 * The editor for the note `S` asks for. Within a line the editing
 * is Node's own `readline`: fed the raw stdin chunks through a stream,
 * writing to one that goes nowhere, and read back through its documented
 * `line` and `cursor`. It already does the line keys a shell does — `ctrl+w`
 * and `alt+backspace` a word back, `ctrl+delete` / `alt+d` a word on,
 * `ctrl+left` / `ctrl+right`, `alt+b` / `alt+f`, `ctrl+a` / `ctrl+e`, home /
 * end, `ctrl+u` / `ctrl+k`, `ctrl+_` to undo. `ink-text-input` only inserts
 * and deletes a character at a time, and Claude Code and Gemini CLI each
 * hand-write theirs.
 *
 * The lines are ours: readline holds the one the cursor is on, and the keys
 * that cross lines are taken before it sees them — the new-line keys Claude
 * Code takes (shift+enter, alt+enter, ctrl+j, `\` before enter), up and
 * down, and a deletion at a line's edge, which joins it to its neighbour. A
 * bracketed paste keeps its line breaks.
 *
 * In its single-line mode (the `/` filter's prompt) Enter always submits, the
 * new-line keys do nothing, and a paste's line breaks become spaces.
 */

export interface NoteState {
    /** The note's lines; the cursor is in `lines[row]`. */
    readonly lines: readonly string[];
    readonly row: number;
    /** In UTF-16 code units, as `line.slice` counts. */
    readonly cursor: number;
}

export interface NoteEditor {
    /** A chunk as read from stdin, mouse reports and all. */
    feed(chunk: string): void;
    /** Empty the note. */
    clear(): void;
    close(): void;
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/**
 * A new line: `ESC CR` (alt+enter, and shift+enter as Claude Code's
 * `/terminal-setup` binds it in VS Code, and as {@link legacyKeys} turns a
 * reported shift+enter), and ctrl+j.
 */
const NEW_LINE = new Set(['\x1b\r', '\n']);
const UP = new Set(['\x1b[A', '\x1bOA']);
const DOWN = new Set(['\x1b[B', '\x1bOB']);
/** Backspace, ctrl+w and alt+backspace: at a line's start, each joins it to the line above. */
const BACK = new Set(['\x7f', '\x17', '\x1b\x7f']);
const DELETE = '\x1b[3~';
const CTRL_D = '\x04';
/** Everything the editor takes before readline, longest first where one starts another. */
const KEYS =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the keys' bytes.
    /\x1b\[20[01]~|\x1b\r|\r|\n|\x1b\[A|\x1bOA|\x1b\[B|\x1bOB|\x1b\x7f|\x7f|\x17|\x1b\[3~|\x04/g;
/** A paste's text goes in as typed; its control characters other than tab would be keys to readline. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters.
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/g;

const codePoints = (s: string) => [...s].length;

/**
 * Sent while the note is open, so shift+enter can be told from Enter: xterm's
 * modifyOtherKeys level 1 (what tmux's `extended-keys` answers, in its
 * `extended-keys-format`) and the kitty keyboard protocol's first flag
 * (terminals that speak it outside tmux; tmux 3.7 ignores it). Both report
 * only keys that have no plain encoding, so typing is unchanged.
 */
export const EXTENDED_KEYS_ON = '\x1b[>4;1m\x1b[>1u';
export const EXTENDED_KEYS_OFF = '\x1b[<u\x1b[>4m';

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences.
const CSI_U = /\x1b\[(\d+)(?::\d*)*(?:;(\d*)(?::(\d+))?)?(?:;[\d:]*)?u/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences.
const MODIFY_OTHER_KEYS = /\x1b\[27;(\d+);(\d+)~/g;

/** One reported key as the plain bytes readline reads; '' for one the note has no use for. */
function legacyKey(code: number, modifiers: number, event = 1): string {
    if (event === 3) return ''; // a release
    const bits = Math.max(0, modifiers - 1);
    const shift = (bits & 1) > 0;
    const alt = (bits & 2) > 0;
    const ctrl = (bits & 4) > 0;
    if (code === 13) return shift || alt ? '\x1b\r' : '\r';
    if (code === 127 || code === 8) return ctrl || alt ? '\x17' : '\x7f';
    if (code === 9) return shift ? '\x1b[Z' : '\t';
    if (code === 27) return '\x1b';
    if (code < 32 || code >= 0xe000) return ''; // kitty's own keys (keypad, media) sit in the private use area
    let ch = String.fromCodePoint(code);
    if (ctrl) {
        const upper = ch.toUpperCase().charCodeAt(0);
        if (upper < 64 || upper > 95) return '';
        ch = String.fromCharCode(upper & 0x1f);
    } else if (shift) ch = ch.toUpperCase();
    return alt ? `\x1b${ch}` : ch;
}

/**
 * Keys reported in kitty's `CSI code ; modifiers u` or xterm's modifyOtherKeys
 * `CSI 27 ; modifiers ; code ~`, as the plain bytes readline reads. Ink decodes
 * these for `useInput` but doesn't export its parser, and readline reads only
 * the plain forms, so the translation is ours: what the note needs and no more.
 */
export function legacyKeys(s: string): string {
    return s
        .replace(MODIFY_OTHER_KEYS, (_m, mods: string, code: string) =>
            legacyKey(Number(code), Number(mods)),
        )
        .replace(CSI_U, (_m, code: string, mods: string | undefined, event: string | undefined) =>
            legacyKey(Number(code), Number(mods || 1), Number(event || 1)),
        );
}

export function noteEditor(handlers: {
    onChange(state: NoteState): void;
    /** Enter, with the lines joined by `\n`. The editor is closed by then. */
    onSubmit(text: string): void;
    /** `ctrl+d` on an empty note. The editor is closed by then. */
    onEnd(): void;
    /**
     * Where up (`-1`) or down (`1`) goes — the row above or below on screen,
     * which only the layout knows; undefined stays put. Without it, a line up
     * or down.
     */
    vertical?(dir: -1 | 1, state: NoteState): { row: number; cursor: number } | undefined;
    /** One line only: see the single-line mode above. */
    singleLine?: boolean;
}): NoteEditor {
    const single = handlers.singleLine === true;
    const input = new PassThrough();
    const nowhere = new Writable({ write: (_chunk, _encoding, done) => done() });
    const rl = readline.createInterface({
        input,
        output: nowhere,
        terminal: true,
        historySize: 0,
        prompt: '',
        // Real escape sequences arrive whole; a longer wait would read Esc and the next key as alt+key.
        escapeCodeTimeout: 50,
    });
    // Without a listener, ctrl+c pauses the input; Ink handles ctrl+c itself.
    rl.on('SIGINT', () => {});
    let open = true;
    let held = '';
    let pasting = false;
    /** The last key of a paste was CR, so an LF straight after it is the same line break. */
    let afterCr = false;
    const lines = [''];
    let row = 0;

    const send = (keys: string) => {
        if (keys) input.write(keys);
        lines[row] = rl.line;
    };
    /** Put `text` in readline with the cursor `at` code units in, by keys: readline has no call that sets its line. */
    const load = (text: string, at: number) => {
        send('\x05\x15'); // to the end, then delete to the start
        send(text);
        send(`\x01${'\x1b[C'.repeat(codePoints(text.slice(0, at)))}`);
    };
    const breakLine = () => {
        const line = rl.line;
        const at = rl.cursor;
        lines.splice(row, 1, line.slice(0, at), line.slice(at));
        row++;
        load(line.slice(at), 0);
    };
    const joinUp = () => {
        const above = lines[row - 1] ?? '';
        const here = rl.line;
        lines.splice(row - 1, 2, above + here);
        row--;
        load(above + here, above.length);
    };
    const joinDown = () => {
        const here = rl.line;
        lines.splice(row, 2, here + (lines[row + 1] ?? ''));
        load(lines[row] ?? '', here.length);
    };
    const goTo = (to: number, cursor: number) => {
        row = to;
        load(lines[row] ?? '', cursor);
    };
    const vertical = (dir: -1 | 1) => {
        if (handlers.vertical) {
            const to = handlers.vertical(dir, { lines: [...lines], row, cursor: rl.cursor });
            if (to) goTo(to.row, to.cursor);
        } else if (row + dir >= 0 && row + dir < lines.length) moveTo(row + dir);
    };
    const moveTo = (to: number) => {
        // Keep the column, counted in characters, as far as the other line goes.
        const column = codePoints(rl.line.slice(0, rl.cursor));
        row = to;
        const there = lines[row] ?? '';
        load(there, [...there].slice(0, column).join('').length);
    };
    const finish = (submitted: boolean) => {
        open = false;
        rl.close();
        if (submitted) handlers.onSubmit(lines.join('\n'));
        else handlers.onEnd();
    };

    const key = (k: string) => {
        if (pasting) {
            if (k === PASTE_END) pasting = false;
            else if (k === '\r' || (k === '\n' && !afterCr)) {
                if (single) send(' ');
                else breakLine();
            }
            afterCr = k === '\r';
            return;
        }
        if (k === PASTE_START) pasting = true;
        else if (k === '\r') {
            // `\` before Enter is a new line (Claude Code's quick escape), the `\` dropped.
            if (!single && rl.line.slice(0, rl.cursor).endsWith('\\')) {
                send('\x7f');
                breakLine();
            } else finish(true);
        } else if (NEW_LINE.has(k)) {
            if (!single) breakLine();
        } else if (UP.has(k)) vertical(-1);
        else if (DOWN.has(k)) vertical(1);
        else if (BACK.has(k) && rl.cursor === 0 && row > 0) joinUp();
        else if ((k === DELETE || k === CTRL_D) && rl.cursor === rl.line.length) {
            if (row < lines.length - 1) joinDown();
            else if (k === CTRL_D && lines.every((l) => l === '')) finish(false);
            // readline would close on ctrl+d in an empty line: never pass it one.
        } else send(k);
    };
    const text = (s: string) => {
        if (!s) return;
        afterCr = false;
        send(pasting ? s.replace(CONTROL, '') : s);
    };

    return {
        feed(chunk) {
            if (!open) return;
            const split = withoutMouseReports(held + chunk);
            held = split.held;
            // `^H` is what xterm-style terminals send for ctrl+backspace; readline would delete a character.
            const keys = legacyKeys(split.keys).replaceAll('\b', '\x17');
            let at = 0;
            for (const m of keys.matchAll(KEYS)) {
                text(keys.slice(at, m.index));
                key(m[0]);
                if (!open) return;
                at = m.index + m[0].length;
            }
            text(keys.slice(at));
            handlers.onChange({ lines: [...lines], row, cursor: rl.cursor });
        },
        clear() {
            if (!open) return;
            lines.splice(0, lines.length, '');
            row = 0;
            load('', 0);
            handlers.onChange({ lines: [''], row: 0, cursor: 0 });
        },
        close() {
            if (!open) return;
            open = false;
            rl.close();
        },
    };
}
