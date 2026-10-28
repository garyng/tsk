import { describe, expect, it } from 'vitest';
import {
    brokenRefCode,
    formatIdList,
    isRelationshipKey,
    parseBrokenRefCode,
    parseIdList,
    RELATIONSHIP_KEYS,
    readRelationships,
} from './relationships';

describe('RELATIONSHIP_KEYS', () => {
    it('is the four forward edge keys', () => {
        expect(RELATIONSHIP_KEYS).toEqual(['parent', 'dependsOn', 'relatedTo', 'movedTo']);
    });
});

describe('isRelationshipKey', () => {
    it('accepts each relationship key', () => {
        for (const k of RELATIONSHIP_KEYS) expect(isRelationshipKey(k)).toBe(true);
    });
    it('rejects non-relationship strings (incl. inverse names and metadata keys)', () => {
        for (const k of ['id', 'created', 'movedHereFrom', 'children', 'priority', '', 'Parent']) {
            expect(isRelationshipKey(k)).toBe(false);
        }
    });
});

describe('readRelationships', () => {
    it('extracts the relationship edges present, ignoring non-relationship keys', () => {
        const md = new Map<string, string | null>([
            ['parent', 'p1'],
            ['dependsOn', 'd1'],
            ['id', 'x'],
            ['created', '2026-01-01'],
        ]);
        expect(readRelationships(md)).toEqual({ parent: 'p1', dependsOn: 'd1' });
    });

    it('skips absent and value-less (@flag → null) keys', () => {
        expect(readRelationships(new Map([['movedTo', null]]))).toEqual({});
        expect(readRelationships(new Map())).toEqual({});
    });

    it('keeps an empty-string value (matches the prior `?? undefined` behaviour)', () => {
        expect(readRelationships(new Map([['relatedTo', '']]))).toEqual({ relatedTo: '' });
    });
});

describe('parseIdList / formatIdList', () => {
    it('reads a comma list in written order, trimming, dropping empties and repeats', () => {
        expect(parseIdList('b,a')).toEqual(['b', 'a']);
        expect(parseIdList(' a , b ,, a')).toEqual(['a', 'b']);
        expect(parseIdList('a')).toEqual(['a']);
    });
    it('reads nothing from an absent, value-less or empty value', () => {
        expect(parseIdList(undefined)).toEqual([]);
        expect(parseIdList(null)).toEqual([]);
        expect(parseIdList('')).toEqual([]);
    });
    it('writes ids back without spaces', () => {
        expect(formatIdList(['a', 'b'])).toBe('a,b');
    });
});

describe('brokenRefCode / parseBrokenRefCode', () => {
    it('round-trips the key and the target', () => {
        expect(brokenRefCode('dependsOn', 'ghost')).toBe('broken-ref:dependsOn:ghost');
        expect(parseBrokenRefCode('broken-ref:dependsOn:ghost')).toEqual({
            key: 'dependsOn',
            targetId: 'ghost',
        });
    });
    it('keeps a target that itself contains a colon', () => {
        expect(parseBrokenRefCode('broken-ref:parent:a:b')).toEqual({
            key: 'parent',
            targetId: 'a:b',
        });
    });
    it('rejects other codes, unknown keys, and the old key-only shape', () => {
        for (const code of ['duplicate-id:x', 'broken-ref:children:x', 'broken-ref:parent', 7]) {
            expect(parseBrokenRefCode(code)).toBeUndefined();
        }
    });
});
