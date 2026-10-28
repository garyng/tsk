/**
 * The terminal's background colour, asked with OSC 11 before Ink takes stdin
 * over, so the selection's tint is mixed into the real background and a light
 * terminal gets the light colours. No maintained npm package does this
 * (searched 2026-10-20); Claude Code, Gemini CLI and Codex each ask the same
 * way, and fall back to `COLORFGBG`, then to dark.
 *
 * A DA1 query (`ESC [ c`) follows the OSC 11 one. Every terminal answers DA1,
 * and answers in order, so a terminal that ignores OSC 11 — or a tmux with no
 * client attached — costs no wait: its DA1 reply arrives alone. tmux 3.7
 * answers OSC 11 itself with the attached terminal's background (7 ms here).
 */

export const BACKGROUND_QUERY = '\x1b]11;?\x07\x1b[c';

/** `#rrggbb` from an OSC 11 reply (`ESC ] 11 ; rgb:RRRR/GGGG/BBBB`, 1–4 hex digits a channel). */
export function parseBackground(reply: string): string | undefined {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's reply starts with ESC.
    const m = /\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply);
    if (!m) return undefined;
    const byte = (h: string) => Math.round((Number.parseInt(h, 16) / (16 ** h.length - 1)) * 255);
    return `#${m
        .slice(1, 4)
        .map((h) => byte(h).toString(16).padStart(2, '0'))
        .join('')}`;
}

/** The DA1 reply, which ends the wait. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's reply starts with ESC.
export const answered = (reply: string): boolean => /\x1b\[\?[\d;]*c/.test(reply);

/** Dark when its luminance is at most half (Claude Code's rule). */
export function isDark(hex: string): boolean {
    const n = Number.parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 <= 0.5;
}

/** `COLORFGBG` (`fg;bg`, set by rxvt, Konsole and others): background colour 0–6 or 8 is dark. */
export function darkFromColorFgBg(value: string | undefined): boolean | undefined {
    const bg = Number(value?.split(';').at(-1));
    if (value === undefined || !Number.isInteger(bg)) return undefined;
    return bg <= 6 || bg === 8;
}

interface TtyIn {
    readonly isTTY?: boolean;
    readonly isRaw?: boolean;
    setRawMode?(raw: boolean): unknown;
    on(event: 'data', cb: (chunk: Buffer | string) => void): unknown;
    off(event: 'data', cb: (chunk: Buffer | string) => void): unknown;
    resume(): unknown;
    pause(): unknown;
}
interface TtyOut {
    readonly isTTY?: boolean;
    write(s: string): unknown;
}

/** Ask the terminal; `undefined` when it isn't one, doesn't say, or takes longer than `timeoutMs`. */
export function queryBackground(
    stdin: TtyIn,
    stdout: TtyOut,
    timeoutMs = 250,
): Promise<string | undefined> {
    if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) return Promise.resolve(undefined);
    const wasRaw = stdin.isRaw ?? false;
    return new Promise((resolve) => {
        let reply = '';
        const finish = () => {
            clearTimeout(timer);
            stdin.off('data', onData);
            stdin.setRawMode?.(wasRaw);
            stdin.pause();
            resolve(parseBackground(reply));
        };
        const onData = (chunk: Buffer | string) => {
            reply += chunk.toString();
            if (answered(reply)) finish();
        };
        const timer = setTimeout(finish, timeoutMs);
        stdin.setRawMode?.(true);
        stdin.on('data', onData);
        stdin.resume();
        stdout.write(BACKGROUND_QUERY);
    });
}
