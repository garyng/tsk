import { describe, expect, it } from 'vitest';
import { parseDocument } from './parser';
import { computeSemanticTokens } from './semantic-tokens';

describe('computeSemanticTokens', () => {
    it('emits a taskMarker token per triplet, tagged with its status', () => {
        const tasks = parseDocument(['- [ ] todo', '- [/] wip', '- [x] done'].join('\n'));
        expect(computeSemanticTokens(tasks)).toEqual([
            { line: 0, char: 2, length: 3, tokenType: 'taskMarker', status: 'todo' },
            { line: 1, char: 2, length: 3, tokenType: 'taskMarker', status: 'inprogress' },
            { line: 2, char: 2, length: 3, tokenType: 'taskMarker', status: 'completed' },
        ]);
    });

    it('emits a taskMetadata token covering each <!-- ... --> block', () => {
        const raw = '- [x] done <!-- @id:a @created:2026-01-01T00:00:00+08:00 -->';
        const tokens = computeSemanticTokens(parseDocument(raw));
        const start = raw.indexOf('<!--');
        // Marker first (char 2), then the metadata span — both on line 0.
        expect(tokens).toEqual([
            { line: 0, char: 2, length: 3, tokenType: 'taskMarker', status: 'completed' },
            { line: 0, char: start, length: raw.length - start, tokenType: 'taskMetadata' },
        ]);
    });

    it('orders tokens ascending by (line, char) — marker before its metadata', () => {
        const tasks = parseDocument(['- [x] a <!-- @id:x -->', '- [/] b'].join('\n'));
        const shape = computeSemanticTokens(tasks).map((t) => [t.line, t.char, t.tokenType]);
        expect(shape).toEqual([
            [0, 2, 'taskMarker'],
            [0, 8, 'taskMetadata'],
            [1, 2, 'taskMarker'],
        ]);
    });

    it('locates the marker triplet past indentation and odd bullet spacing', () => {
        const tasks = parseDocument(['    - [!] indented', '-   [n] spaced'].join('\n'));
        const markers = computeSemanticTokens(tasks).filter((t) => t.tokenType === 'taskMarker');
        expect(markers).toEqual([
            { line: 0, char: 6, length: 3, tokenType: 'taskMarker', status: 'cancelled' },
            { line: 1, char: 4, length: 3, tokenType: 'taskMarker', status: 'notes' },
        ]);
    });

    it('ignores non-task lines (headings, prose, bare bullets)', () => {
        const tasks = parseDocument(['# heading', 'plain text', '- bare bullet'].join('\n'));
        expect(computeSemanticTokens(tasks)).toEqual([]);
    });
});
