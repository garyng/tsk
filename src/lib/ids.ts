import { customAlphabet } from 'nanoid';

/**
 * 0-9 and a-z, with the visually-ambiguous chars `0`, `1`, `i`, `l`, `o`
 * removed. 31 characters.
 */
export const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const ID_LENGTH = 8;

/** Secure-random task ID (8 chars, ~852e9 keyspace). */
export const generateId: () => string = customAlphabet(ALPHABET, ID_LENGTH);

/**
 * Test-friendly variant: build an ID from a caller-provided RNG.
 *
 * The RNG must return a uniform value in `[0, 1)`. Pair with a seeded PRNG
 * (e.g. `mulberry32` below) for deterministic IDs in tests.
 */
export function generateIdWith(rng: () => number): string {
    let id = '';
    for (let i = 0; i < ID_LENGTH; i++) {
        id += ALPHABET[Math.floor(rng() * ALPHABET.length)];
    }
    return id;
}

/**
 * Tiny seedable PRNG — mulberry32. Not cryptographic; used only for tests
 * where determinism matters more than entropy.
 */
export function mulberry32(seed: number): () => number {
    let state = seed | 0;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
