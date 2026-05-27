import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleDebounced } from './debounce';

describe('scheduleDebounced', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('fires fn after ms when not interrupted', () => {
        const map = new Map<string, NodeJS.Timeout>();
        const fn = vi.fn();
        scheduleDebounced(map, 'k', 100, fn);

        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(99);
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('resets the timer when called again with the same key', () => {
        const map = new Map<string, NodeJS.Timeout>();
        const fn = vi.fn();
        scheduleDebounced(map, 'k', 100, fn);
        vi.advanceTimersByTime(80);
        scheduleDebounced(map, 'k', 100, fn);
        vi.advanceTimersByTime(80);
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(20);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('keeps different keys independent', () => {
        const map = new Map<string, NodeJS.Timeout>();
        const fnA = vi.fn();
        const fnB = vi.fn();
        scheduleDebounced(map, 'a', 100, fnA);
        scheduleDebounced(map, 'b', 200, fnB);

        vi.advanceTimersByTime(100);
        expect(fnA).toHaveBeenCalledTimes(1);
        expect(fnB).not.toHaveBeenCalled();

        vi.advanceTimersByTime(100);
        expect(fnB).toHaveBeenCalledTimes(1);
    });

    it('removes the key from the map after the timer fires', () => {
        const map = new Map<string, NodeJS.Timeout>();
        scheduleDebounced(map, 'k', 100, () => {});
        expect(map.has('k')).toBe(true);
        vi.advanceTimersByTime(100);
        expect(map.has('k')).toBe(false);
    });

    it('re-scheduling after a fire creates a fresh timer', () => {
        const map = new Map<string, NodeJS.Timeout>();
        const fn = vi.fn();
        scheduleDebounced(map, 'k', 100, fn);
        vi.advanceTimersByTime(100);
        expect(fn).toHaveBeenCalledTimes(1);

        scheduleDebounced(map, 'k', 50, fn);
        vi.advanceTimersByTime(50);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('replaces the timer entry — never leaves two pending for the same key', () => {
        const map = new Map<string, NodeJS.Timeout>();
        scheduleDebounced(map, 'k', 100, () => {});
        const firstTimer = map.get('k');
        scheduleDebounced(map, 'k', 100, () => {});
        const secondTimer = map.get('k');
        expect(firstTimer).not.toBe(secondTimer);
        expect(map.size).toBe(1);
    });
});
