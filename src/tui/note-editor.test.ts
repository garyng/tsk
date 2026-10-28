import { describe, expect, it } from 'vitest';
import { withoutMouseReports } from './mouse';
import { legacyKeys, type NoteState, noteEditor } from './note-editor';

function editor(singleLine = false) {
    let state: NoteState = { lines: [''], row: 0, cursor: 0 };
    const submitted: string[] = [];
    let ended = 0;
    const ed = noteEditor({
        onChange: (s) => {
            state = s;
        },
        onSubmit: (t) => submitted.push(t),
        onEnd: () => {
            ended++;
        },
        singleLine,
    });
    return {
        ed,
        submitted,
        ended: () => ended,
        /** Feed a chunk; the note's lines joined by `/`, with `|` at the cursor. */
        type: (chunk: string) => {
            ed.feed(chunk);
            return state.lines
                .map((l, i) =>
                    i === state.row ? `${l.slice(0, state.cursor)}|${l.slice(state.cursor)}` : l,
                )
                .join('/');
        },
    };
}

describe('noteEditor, within a line', () => {
    it('types, and deletes a word back on ctrl+w, alt+backspace, and ^H (ctrl+backspace in xterm-style terminals)', () => {
        const e = editor();
        expect(e.type('fix the big drag')).toBe('fix the big drag|');
        expect(e.type('\x17')).toBe('fix the big |');
        expect(e.type('\x1b\x7f')).toBe('fix the |');
        expect(e.type('\b')).toBe('fix |');
        expect(e.type('\x7f')).toBe('fix|');
    });

    it('moves and deletes by words and to the ends', () => {
        const e = editor();
        e.type('one two three');
        expect(e.type('\x1b[1;5D')).toBe('one two |three'); // ctrl+left
        expect(e.type('\x1bb')).toBe('one |two three'); // alt+b
        expect(e.type('\x1b[3;5~')).toBe('one |three'); // ctrl+delete
        expect(e.type('\x1bd')).toBe('one |'); // alt+d
        expect(e.type('\x1b[H')).toBe('|one '); // home
        expect(e.type('\x0b')).toBe('|'); // ctrl+k
        e.type('abc');
        expect(e.type('\x01')).toBe('|abc'); // ctrl+a
        expect(e.type('\x05')).toBe('abc|'); // ctrl+e
        expect(e.type('\x15')).toBe('|'); // ctrl+u
    });

    it('leaves mouse reports out, even one split across reads', () => {
        const e = editor();
        expect(e.type('a\x1b[<0;10;5Mb')).toBe('ab|');
        expect(e.type('c\x1b[<64;1')).toBe('abc|');
        expect(e.type('0;5Md')).toBe('abcd|');
    });
});

describe('noteEditor, on one line', () => {
    it('ignores the new-line keys, and sends on Enter even after a backslash', () => {
        const e = editor(true);
        for (const key of ['\x1b\r', '\x1b[13;2u', '\n'])
            expect(e.type(`a${key}`)).not.toContain('/');
        expect(e.type('\\')).toBe('aaa\\|');
        e.type('\r');
        expect(e.submitted).toEqual(['aaa\\']);
    });

    it("turns a paste's line breaks into spaces", () => {
        const e = editor(true);
        expect(e.type('\x1b[200~one\r\ntwo\nthree\x1b[201~')).toBe('one two three|');
    });
});

describe('noteEditor, across lines', () => {
    it('breaks the line on each of the new-line keys, at the cursor', () => {
        for (const key of ['\x1b\r', '\x1b[27;2;13~', '\x1b[13;2u', '\n']) {
            const e = editor();
            e.type('onetwo\x1b[D\x1b[D\x1b[D');
            expect(e.type(key)).toBe('one/|two');
        }
    });

    it('asks the layout where up and down go, and goes there', () => {
        let state: NoteState = { lines: [''], row: 0, cursor: 0 };
        const asked: [number, NoteState][] = [];
        const ed = noteEditor({
            onChange: (s) => {
                state = s;
            },
            onSubmit: () => {},
            onEnd: () => {},
            vertical: (dir, s) => {
                asked.push([dir, s]);
                return dir === -1 ? { row: 0, cursor: 2 } : undefined;
            },
        });
        ed.feed('abcdef\nxy');
        ed.feed('\x1b[A');
        expect(asked).toEqual([[-1, { lines: ['abcdef', 'xy'], row: 1, cursor: 2 }]]);
        expect(state).toEqual({ lines: ['abcdef', 'xy'], row: 0, cursor: 2 });
        ed.feed('\x1b[B'); // undefined: stays put
        expect(state).toEqual({ lines: ['abcdef', 'xy'], row: 0, cursor: 2 });
    });

    it('takes a backslash before Enter as a new line, dropping the backslash', () => {
        const e = editor();
        expect(e.type('first\\\r')).toBe('first/|');
        e.type('second\r');
        expect(e.submitted).toEqual(['first\nsecond']);
    });

    it('moves up and down keeping the column, and joins lines on a deletion at their edge', () => {
        const e = editor();
        e.type('abcdef\nxy\nlonger line');
        expect(e.type('\x1b[A')).toBe('abcdef/xy|/longer line'); // up, to the end of a shorter line
        expect(e.type('\x1b[A')).toBe('ab|cdef/xy/longer line');
        expect(e.type('\x1b[B\x1b[B')).toBe('abcdef/xy/lo|nger line');
        expect(e.type('\x01\x7f')).toBe('abcdef/xy|longer line'); // backspace at the start joins up
        expect(e.type('\x1b[A\x05\x1b[3~')).toBe('abcdef|xylonger line'); // delete at the end joins down
    });

    it('keeps the line breaks of a bracketed paste instead of sending, and drops its control characters', () => {
        const e = editor();
        expect(e.type('see \x1b[200~line one\r\nline\x07 two\rthree\x1b[201~!')).toBe(
            'see line one/line two/three!|',
        );
        expect(e.submitted).toEqual([]);
        e.type('\r');
        expect(e.submitted).toEqual(['see line one\nline two\nthree!']);
    });

    it('submits on Enter and stops taking keys', () => {
        const e = editor();
        e.type('ship it\r');
        expect(e.submitted).toEqual(['ship it']);
        e.type('more\r');
        expect(e.submitted).toEqual(['ship it']);
        expect(e.ended()).toBe(0);
    });

    it('clears the note, and ends on ctrl+d only when all of it is empty', () => {
        const e = editor();
        e.type('some\nwords');
        e.ed.clear();
        expect(e.type('')).toBe('|');
        e.type('x\n');
        e.type('\x04'); // an empty last line, but the note isn't empty
        expect(e.ended()).toBe(0);
        e.ed.clear();
        e.type('\x04');
        expect(e.ended()).toBe(1);
        expect(e.submitted).toEqual([]);
    });
});

describe('legacyKeys', () => {
    it("turns kitty's CSI u keys into the plain bytes readline reads", () => {
        expect(legacyKeys('\x1b[13;2u')).toBe('\x1b\r'); // shift+enter: a new line
        expect(legacyKeys('\x1b[13u')).toBe('\r');
        expect(legacyKeys('\x1b[127;5u')).toBe('\x17'); // ctrl+backspace
        expect(legacyKeys('\x1b[127;3u')).toBe('\x17'); // alt+backspace
        expect(legacyKeys('\x1b[119;5u')).toBe('\x17'); // ctrl+w
        expect(legacyKeys('\x1b[98;3u')).toBe('\x1bb'); // alt+b
        expect(legacyKeys('\x1b[27u')).toBe('\x1b'); // Esc, disambiguated
        expect(legacyKeys('\x1b[97;2u')).toBe('A');
        expect(legacyKeys('\x1b[13;2:3u')).toBe(''); // a release
        expect(legacyKeys('\x1b[57414u')).toBe(''); // the keypad's Enter, kitty's own code
    });
    it("turns xterm's modifyOtherKeys reports into plain bytes too, as tmux sends them", () => {
        expect(legacyKeys('\x1b[27;2;13~')).toBe('\x1b\r'); // shift+enter
        expect(legacyKeys('\x1b[27;3;13~')).toBe('\x1b\r'); // alt+enter
        expect(legacyKeys('\x1b[27;5;127~')).toBe('\x17'); // ctrl+backspace
        expect(legacyKeys('\x1b[27;5;97~')).toBe('\x01'); // ctrl+a
    });
    it('leaves everything else alone', () => {
        expect(legacyKeys('plain \x1b[1;5D\x1b[3~ text')).toBe('plain \x1b[1;5D\x1b[3~ text');
    });
});

describe('noteEditor, with extended keys', () => {
    it('breaks the line on a reported shift+enter, and deletes a word on a reported ctrl+backspace', () => {
        const e = editor();
        e.type('one two');
        expect(e.type('\x1b[127;5u')).toBe('one |');
        expect(e.type('\x1b[27;2;13~')).toBe('one /|');
        expect(e.type('\x1b[13;2')).toBe('one /|'); // cut off: held for the next read
        expect(e.type('u')).toBe('one //|');
    });
});

describe('withoutMouseReports', () => {
    it('takes out whole reports and holds back a cut-off one, but not a lone ESC', () => {
        expect(withoutMouseReports('x\x1b[<0;1;1My')).toEqual({ keys: 'xy', held: '' });
        expect(withoutMouseReports('x\x1b[<0;1')).toEqual({ keys: 'x', held: '\x1b[<0;1' });
        expect(withoutMouseReports('x\x1b')).toEqual({ keys: 'x\x1b', held: '' });
        expect(withoutMouseReports('x\x1b[1;5')).toEqual({ keys: 'x', held: '\x1b[1;5' });
    });
});
