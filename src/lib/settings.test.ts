import { describe, expect, it } from 'vitest';
import { clampPriorityOpacity, parseChangeDebounceMs, parseLogLevel } from './settings';

describe('parseLogLevel', () => {
    it('passes each valid level through unchanged', () => {
        for (const level of ['debug', 'info', 'warn', 'error'] as const) {
            expect(parseLogLevel(level)).toBe(level);
        }
    });

    it('recovers an unknown or malformed value to info', () => {
        expect(parseLogLevel('')).toBe('info');
        expect(parseLogLevel('verbose')).toBe('info');
        expect(parseLogLevel('INFO')).toBe('info'); // case-sensitive: not a valid level
    });
});

describe('clampPriorityOpacity', () => {
    it('passes in-range values through unchanged', () => {
        expect(clampPriorityOpacity(0)).toBe(0);
        expect(clampPriorityOpacity(0.15)).toBe(0.15);
        expect(clampPriorityOpacity(1)).toBe(1);
    });

    it('clamps out-of-range values to the nearest bound', () => {
        expect(clampPriorityOpacity(-0.5)).toBe(0);
        expect(clampPriorityOpacity(2)).toBe(1);
    });
});

describe('parseChangeDebounceMs', () => {
    it('passes a valid in-range value through, rounded', () => {
        expect(parseChangeDebounceMs(300)).toBe(300);
        expect(parseChangeDebounceMs(0)).toBe(0);
        expect(parseChangeDebounceMs(149.6)).toBe(150);
    });

    it('clamps out-of-range values to [0, 5000]', () => {
        expect(parseChangeDebounceMs(-1)).toBe(0);
        expect(parseChangeDebounceMs(10000)).toBe(5000);
    });

    it('degrades a non-finite value to 0', () => {
        expect(parseChangeDebounceMs(Number.NaN)).toBe(0);
        expect(parseChangeDebounceMs(Number.POSITIVE_INFINITY)).toBe(0);
    });
});
