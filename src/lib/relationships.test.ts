import { describe, expect, it } from 'vitest';
import { isRelationshipKey, readRelationships, RELATIONSHIP_KEYS } from './relationships';

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
