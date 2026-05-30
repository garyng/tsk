import { describe, expect, it } from 'vitest';
import { clampPriorityOpacity, parseLogLevel } from './settings';

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
