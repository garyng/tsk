import { describe, expect, it } from 'vitest';
import { ALPHABET, generateId, generateIdWith, ID_LENGTH, mulberry32 } from './ids';

describe('ids', () => {
    describe('ALPHABET', () => {
        it('excludes the visually-ambiguous chars 0, 1, i, l, o', () => {
            for (const ch of '01ilo') {
                expect(ALPHABET).not.toContain(ch);
            }
        });

        it('has 31 characters', () => {
            expect(ALPHABET).toHaveLength(31);
        });

        it('contains only chars in [0-9a-z]', () => {
            expect(ALPHABET).toMatch(/^[0-9a-z]+$/);
        });
    });

    describe('generateId', () => {
        it('produces 8-char IDs', () => {
            for (let i = 0; i < 20; i++) {
                expect(generateId()).toHaveLength(ID_LENGTH);
            }
        });

        it('only uses characters from ALPHABET', () => {
            const re = new RegExp(`^[${ALPHABET}]+$`);
            for (let i = 0; i < 20; i++) {
                expect(generateId()).toMatch(re);
            }
        });

        it('returns distinct values on consecutive calls', () => {
            const a = generateId();
            const b = generateId();
            expect(a).not.toBe(b);
        });
    });

    describe('generateIdWith (seedable)', () => {
        it('is deterministic given the same seed', () => {
            const a = generateIdWith(mulberry32(42));
            const b = generateIdWith(mulberry32(42));
            expect(a).toBe(b);
        });

        it('produces different IDs with different seeds', () => {
            const a = generateIdWith(mulberry32(1));
            const b = generateIdWith(mulberry32(2));
            expect(a).not.toBe(b);
        });

        it('respects the alphabet and length', () => {
            const id = generateIdWith(mulberry32(7));
            expect(id).toHaveLength(ID_LENGTH);
            expect(id).toMatch(new RegExp(`^[${ALPHABET}]+$`));
        });
    });
});
