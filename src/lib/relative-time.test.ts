import { describe, expect, it } from 'vitest';
import { formatRelativeShort } from './relative-time';

const NOW = new Date('2026-06-07T12:00:00.000Z');
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
/** ISO string for a time `secs` seconds before NOW (negative → a future stamp). */
const ago = (secs: number): string => new Date(NOW.getTime() - secs * 1000).toISOString();

describe('formatRelativeShort', () => {
    it('returns empty for an unparseable timestamp', () => {
        expect(formatRelativeShort('not-a-date', NOW)).toBe('');
    });

    it('reads sub-minute — and a future (clock-skew) stamp — as "just now"', () => {
        expect(formatRelativeShort(ago(0), NOW)).toBe('just now');
        expect(formatRelativeShort(ago(59), NOW)).toBe('just now');
        expect(formatRelativeShort(ago(-120), NOW)).toBe('just now');
    });

    it('formats minutes and hours', () => {
        expect(formatRelativeShort(ago(MIN), NOW)).toBe('1m ago');
        expect(formatRelativeShort(ago(10 * MIN), NOW)).toBe('10m ago');
        expect(formatRelativeShort(ago(59 * MIN), NOW)).toBe('59m ago');
        expect(formatRelativeShort(ago(HOUR), NOW)).toBe('1h ago');
        expect(formatRelativeShort(ago(23 * HOUR), NOW)).toBe('23h ago');
    });

    it('formats days/weeks/months/years cleanly across the boundaries', () => {
        expect(formatRelativeShort(ago(DAY), NOW)).toBe('1d ago');
        expect(formatRelativeShort(ago(6 * DAY), NOW)).toBe('6d ago');
        expect(formatRelativeShort(ago(7 * DAY), NOW)).toBe('1w ago');
        expect(formatRelativeShort(ago(29 * DAY), NOW)).toBe('4w ago');
        expect(formatRelativeShort(ago(30 * DAY), NOW)).toBe('1mo ago');
        expect(formatRelativeShort(ago(364 * DAY), NOW)).toBe('12mo ago');
        expect(formatRelativeShort(ago(365 * DAY), NOW)).toBe('1y ago');
        expect(formatRelativeShort(ago(800 * DAY), NOW)).toBe('2y ago');
    });
});
