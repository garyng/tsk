import { describe, expect, it } from 'vitest';
import { processStart } from './process-start';

describe('processStart', () => {
    it("is a process's start in clock ticks, the same each time it's read", () => {
        const start = processStart(process.pid);
        expect(start).toMatch(/^\d+$/);
        expect(processStart(process.pid)).toBe(start);
    });

    it('is undefined for a pid no process has', () => {
        expect(processStart(2 ** 22 + 1)).toBeUndefined();
    });
});
