import { describe, expect, it } from 'vitest';
import { replaceMetadata, serializeMetadata } from './metadata';

describe('serializeMetadata', () => {
    it('returns empty string for an empty Map', () => {
        expect(serializeMetadata(new Map())).toBe('');
    });

    it('renders a single @key:value pair', () => {
        const m = new Map<string, string | null>([['id', 'abc12345']]);
        expect(serializeMetadata(m)).toBe('<!-- @id:abc12345 -->');
    });

    it('renders multiple entries in insertion order', () => {
        const m = new Map<string, string | null>([
            ['id', 'abc'],
            ['created', '2026-01-02T12:45:30+08:00'],
        ]);
        expect(serializeMetadata(m)).toBe('<!-- @id:abc @created:2026-01-02T12:45:30+08:00 -->');
    });

    it('renders a null value as @flag (no colon)', () => {
        const m = new Map<string, string | null>([['flag', null]]);
        expect(serializeMetadata(m)).toBe('<!-- @flag -->');
    });

    it('renders an empty-string value as @flag: (colon, no value)', () => {
        const m = new Map<string, string | null>([['flag', '']]);
        expect(serializeMetadata(m)).toBe('<!-- @flag: -->');
    });

    it('keeps null and "" distinct in the same Map', () => {
        const m = new Map<string, string | null>([
            ['a', null],
            ['b', ''],
        ]);
        expect(serializeMetadata(m)).toBe('<!-- @a @b: -->');
    });
});

describe('replaceMetadata', () => {
    describe('mutations', () => {
        it('appends a new key when none existed', () => {
            const line = '- [x] do thing';
            const result = replaceMetadata(line, (m) => m.set('id', 'abc'));
            expect(result).toBe('- [x] do thing <!-- @id:abc -->');
        });

        it('appends a new key alongside existing ones (end of list)', () => {
            const line = '- [x] do <!-- @a:1 -->';
            const result = replaceMetadata(line, (m) => m.set('b', '2'));
            expect(result).toBe('- [x] do <!-- @a:1 @b:2 -->');
        });

        it('updates an existing key value without changing its position', () => {
            const line = '- [x] do <!-- @a:1 @b:2 @c:3 -->';
            const result = replaceMetadata(line, (m) => m.set('b', 'two'));
            expect(result).toBe('- [x] do <!-- @a:1 @b:two @c:3 -->');
        });

        it('removes a deleted key', () => {
            const line = '- [x] do <!-- @a:1 @b:2 -->';
            const result = replaceMetadata(line, (m) => m.delete('a'));
            expect(result).toBe('- [x] do <!-- @b:2 -->');
        });

        it('strips the comment entirely when the Map is emptied', () => {
            const line = '- [x] do <!-- @a:1 -->';
            const result = replaceMetadata(line, (m) => m.clear());
            expect(result).toBe('- [x] do');
        });
    });

    describe('preservation', () => {
        it('returns the line byte-for-byte when no metadata existed and mutator added nothing', () => {
            const line = '- [x] do thing';
            expect(replaceMetadata(line, () => {})).toBe(line);
        });

        it('preserves the line exactly on no-op mutation of existing metadata', () => {
            const line = '- [x] do <!-- @a:1 @b:2 -->';
            expect(replaceMetadata(line, () => {})).toBe(line);
        });

        it('preserves @flag (null) on round-trip', () => {
            const line = '- [x] do <!-- @flag @id:abc -->';
            expect(replaceMetadata(line, () => {})).toBe(line);
        });

        it('preserves @flag: (empty string) on round-trip', () => {
            const line = '- [x] do <!-- @flag: -->';
            expect(replaceMetadata(line, () => {})).toBe(line);
        });

        it('preserves indent (leading whitespace)', () => {
            const line = '    - [x] do <!-- @a:1 -->';
            const result = replaceMetadata(line, (m) => m.set('b', '2'));
            expect(result).toBe('    - [x] do <!-- @a:1 @b:2 -->');
        });

        it('works on non-task lines (caller decides shape)', () => {
            const line = 'plain text <!-- @a:1 -->';
            expect(replaceMetadata(line, (m) => m.set('a', '2'))).toBe('plain text <!-- @a:2 -->');
        });
    });

    describe('whitespace handling', () => {
        it('trims trailing space before appending new metadata', () => {
            const line = '- [x] do thing   ';
            const result = replaceMetadata(line, (m) => m.set('id', 'abc'));
            expect(result).toBe('- [x] do thing <!-- @id:abc -->');
        });

        it('trims trailing space left behind when the comment is removed', () => {
            const line = '- [x] do <!-- @a:1 -->';
            const result = replaceMetadata(line, (m) => m.clear());
            expect(result).toBe('- [x] do');
        });
    });

    describe('multi-comment merging', () => {
        it('merges multiple comment blocks into one at the end', () => {
            const line = '- [x] a <!-- @a:1 --> middle <!-- @b:2 -->';
            const result = replaceMetadata(line, () => {});
            // "middle" stays in content; metadata coalesces at the end.
            expect(result).toBe('- [x] a  middle <!-- @a:1 @b:2 -->');
        });

        it('lets a later comment override an earlier key value', () => {
            const line = '- [x] a <!-- @x:1 --> <!-- @x:2 -->';
            const result = replaceMetadata(line, () => {});
            expect(result).toBe('- [x] a <!-- @x:2 -->');
        });
    });

    describe('mutator API', () => {
        it('treats delete-then-set as moving the key to the end', () => {
            // Documenting current behavior: deletion + re-add moves the
            // key. Callers wanting to preserve position should use `set`
            // directly without deleting first.
            const line = '- [x] do <!-- @a:1 @b:2 @c:3 -->';
            const result = replaceMetadata(line, (m) => {
                m.delete('b');
                m.set('b', 'two');
            });
            expect(result).toBe('- [x] do <!-- @a:1 @c:3 @b:two -->');
        });

        it('passes the actual extracted Map (mutator sees existing keys)', () => {
            const line = '- [x] do <!-- @a:1 @b:2 -->';
            let snapshot: string[] = [];
            replaceMetadata(line, (m) => {
                snapshot = [...m.keys()];
            });
            expect(snapshot).toEqual(['a', 'b']);
        });
    });
});
