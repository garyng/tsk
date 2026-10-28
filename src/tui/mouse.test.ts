import { describe, expect, it } from 'vitest';
import { MOUSE_OFF, MOUSE_ON, mouseParser, mouseReporting } from './mouse';

describe('mouseReporting', () => {
    it('turns reporting on, and off once however often it is stopped', () => {
        const written: string[] = [];
        const stop = mouseReporting({ write: (s: string) => written.push(s) });
        expect(written).toEqual([MOUSE_ON]);
        stop();
        stop();
        expect(written).toEqual([MOUSE_ON, MOUSE_OFF]);
    });
    it('asks for clicks, drags and SGR coordinates, never bare motion; off in reverse', () => {
        expect(MOUSE_ON).toBe('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
        expect(MOUSE_ON).not.toMatch(/1003/);
        expect(MOUSE_OFF).toBe('\x1b[?1006l\x1b[?1002l\x1b[?1000l');
    });
});

const plain = { shift: false, alt: false, ctrl: false };

describe('mouseParser', () => {
    it('reads a press and its release, 0-based', () => {
        const parse = mouseParser();
        expect(parse('\x1b[<0;12;5M\x1b[<0;12;5m')).toEqual([
            { kind: 'press', button: 0, x: 11, y: 4, ...plain },
            { kind: 'release', button: 0, x: 11, y: 4, ...plain },
        ]);
    });

    it('joins a report split across reads, at any point', () => {
        const report = '\x1b[<0;30;17M';
        for (let cut = 1; cut < report.length; cut++) {
            const parse = mouseParser();
            expect(parse(report.slice(0, cut))).toEqual([]);
            expect(parse(report.slice(cut))).toEqual([
                { kind: 'press', button: 0, x: 29, y: 16, ...plain },
            ]);
        }
    });

    it('reads several reports in one chunk, among keys', () => {
        const parse = mouseParser();
        expect(parse('j\x1b[<64;3;3M\x1b[<65;3;3Mk\x1b[<2;1;1M').map((e) => e.kind)).toEqual([
            'wheel',
            'wheel',
            'press',
        ]);
    });

    it('tells the wheel up from down, and skips sideways scrolling and motion with no button', () => {
        const parse = mouseParser();
        expect(parse('\x1b[<64;1;1M\x1b[<65;1;1M\x1b[<66;1;1M\x1b[<35;1;1M')).toEqual([
            { kind: 'wheel', button: -1, x: 0, y: 0, ...plain },
            { kind: 'wheel', button: 1, x: 0, y: 0, ...plain },
        ]);
    });

    it('reads a motion with a button held as a drag', () => {
        const parse = mouseParser();
        expect(parse('\x1b[<0;10;5M\x1b[<32;10;7M\x1b[<34;4;2M\x1b[<0;10;7m')).toEqual([
            { kind: 'press', button: 0, x: 9, y: 4, ...plain },
            { kind: 'drag', button: 0, x: 9, y: 6, ...plain },
            { kind: 'drag', button: 2, x: 3, y: 1, ...plain },
            { kind: 'release', button: 0, x: 9, y: 6, ...plain },
        ]);
    });

    it('reads the modifiers and the button', () => {
        const parse = mouseParser();
        expect(parse('\x1b[<30;1;1M')).toEqual([
            { kind: 'press', button: 2, x: 0, y: 0, shift: true, alt: true, ctrl: true },
        ]);
    });

    it('keeps nothing from an escape that turns out to be a key', () => {
        const parse = mouseParser();
        expect(parse('\x1b[')).toEqual([]);
        expect(parse('A')).toEqual([]);
        expect(parse('\x1b[<0;2;2M')).toEqual([{ kind: 'press', button: 0, x: 1, y: 1, ...plain }]);
    });
});
