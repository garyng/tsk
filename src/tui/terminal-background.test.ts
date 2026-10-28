import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
    BACKGROUND_QUERY,
    darkFromColorFgBg,
    isDark,
    parseBackground,
    queryBackground,
} from './terminal-background';

describe('parseBackground', () => {
    it("reads tmux's reply (four hex digits a channel, BEL-terminated)", () => {
        expect(parseBackground('\x1b]11;rgb:1e1e/1e1e/1e1e\x07\x1b[?1;2c')).toBe('#1e1e1e');
    });
    it('scales shorter channels, and takes the ST terminator', () => {
        expect(parseBackground('\x1b]11;rgb:f/80/ff\x1b\\')).toBe('#ff80ff');
    });
    it('is undefined when the terminal only answered DA1', () => {
        expect(parseBackground('\x1b[?1;2c')).toBeUndefined();
    });
});

describe('isDark', () => {
    it('splits at half the luminance, weighting green the most', () => {
        expect(isDark('#1e1e1e')).toBe(true);
        expect(isDark('#ffffff')).toBe(false);
        expect(isDark('#00c000')).toBe(false);
        expect(isDark('#0000ff')).toBe(true);
    });
});

describe('darkFromColorFgBg', () => {
    it('reads the background index: 0–6 and 8 are dark', () => {
        expect(darkFromColorFgBg('15;0')).toBe(true);
        expect(darkFromColorFgBg('0;15')).toBe(false);
        expect(darkFromColorFgBg('15;default;8')).toBe(true);
    });
    it('is undefined when unset or unreadable', () => {
        expect(darkFromColorFgBg(undefined)).toBeUndefined();
        expect(darkFromColorFgBg('default')).toBeUndefined();
    });
});

/** A terminal that answers the query with `reply` (or never, for `undefined`). */
function fakeTty(reply: string | undefined) {
    const stdin = Object.assign(new EventEmitter(), {
        isTTY: true,
        isRaw: false,
        raw: [] as boolean[],
        setRawMode(raw: boolean) {
            this.raw.push(raw);
            this.isRaw = raw;
        },
        resume() {},
        pause() {},
    });
    const written: string[] = [];
    const stdout = {
        isTTY: true,
        write(s: string) {
            written.push(s);
            if (reply !== undefined) setTimeout(() => stdin.emit('data', Buffer.from(reply)), 1);
        },
    };
    return { stdin, stdout, written };
}

describe('queryBackground', () => {
    it("asks once, reads the answer, and puts the terminal's mode back", async () => {
        const t = fakeTty('\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[?1;2c');
        expect(await queryBackground(t.stdin, t.stdout)).toBe('#ffffff');
        expect(t.written).toEqual([BACKGROUND_QUERY]);
        expect(t.stdin.raw).toEqual([true, false]);
        expect(t.stdin.listenerCount('data')).toBe(0);
    });
    it('stops at the DA1 reply when the terminal ignores OSC 11', async () => {
        const t = fakeTty('\x1b[?1;2c');
        const started = Date.now();
        expect(await queryBackground(t.stdin, t.stdout, 5000)).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(1000);
    });
    it('gives up after the timeout when nothing answers', async () => {
        const t = fakeTty(undefined);
        expect(await queryBackground(t.stdin, t.stdout, 20)).toBeUndefined();
        expect(t.stdin.listenerCount('data')).toBe(0);
    });
    it("doesn't ask when stdin isn't a terminal", async () => {
        const t = fakeTty('\x1b]11;rgb:0/0/0\x07\x1b[?1;2c');
        expect(
            await queryBackground({ ...t.stdin, isTTY: false } as never, t.stdout),
        ).toBeUndefined();
        expect(t.written).toEqual([]);
    });
});
