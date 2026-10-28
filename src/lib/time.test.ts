import { describe, expect, it } from 'vitest';
import { localTimestamp, localTimestampMs } from './time';

/**
 * Compute the timezone-offset substring the formatter would produce for a
 * given Date in the current runtime's TZ. Mirrors the production logic so
 * tests are robust regardless of which TZ the test host is in.
 */
function expectedOffset(date: Date): string {
    const pad = (n: number): string => n.toString().padStart(2, '0');
    const offsetMin = -date.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const absOff = Math.abs(offsetMin);
    return `${sign}${pad(Math.floor(absOff / 60))}:${pad(absOff % 60)}`;
}

describe('localTimestamp', () => {
    it('formats a known local date with second precision and TZ offset', () => {
        const d = new Date(2026, 0, 2, 12, 45, 30);
        expect(localTimestamp(d)).toBe(`2026-01-02T12:45:30${expectedOffset(d)}`);
    });

    it('zero-pads single-digit fields including seconds', () => {
        const d = new Date(2026, 2, 5, 7, 3, 4);
        expect(localTimestamp(d)).toBe(`2026-03-05T07:03:04${expectedOffset(d)}`);
    });

    it('matches the YYYY-MM-DDTHH:mm:ss±HH:MM shape', () => {
        expect(localTimestamp(new Date())).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
        );
    });

    it('does not include a Z (UTC) suffix', () => {
        expect(localTimestamp(new Date())).not.toMatch(/Z$/);
    });

    it('uses current time when no date is provided', () => {
        const now = new Date();
        expect(localTimestamp()).toBe(localTimestamp(now));
    });
});

describe('localTimestampMs', () => {
    it('is localTimestamp with zero-padded milliseconds before the offset', () => {
        const d = new Date(2026, 0, 2, 12, 45, 30, 7);
        expect(localTimestampMs(d)).toBe(`2026-01-02T12:45:30.007${expectedOffset(d)}`);
    });

    it('parses back to the same instant', () => {
        const d = new Date(2026, 9, 23, 5, 6, 7, 891);
        expect(Date.parse(localTimestampMs(d))).toBe(d.getTime());
    });
});
