/**
 * Schedule `fn` to run after `ms` milliseconds, keyed by `key` against
 * `map`. If a timer for `key` is already pending, it's cleared and
 * replaced — only the last-scheduled invocation per key fires. When the
 * timer fires it removes its own entry from `map`, so a long-idle key
 * doesn't leak across activations.
 *
 * The shared `map` is the caller's bookkeeping; pass a fresh `Map` per
 * "channel" (e.g. one for rescan, a separate one for decoration refresh)
 * to keep their cadences independent.
 *
 * Pure with respect to its inputs — no module-level state, no vscode
 * dependency. The fn / map / key shape is the entire surface, which
 * makes the helper unit-testable with vitest fake timers.
 */
export function scheduleDebounced(
    map: Map<string, NodeJS.Timeout>,
    key: string,
    ms: number,
    fn: () => void,
): void {
    const existing = map.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        map.delete(key);
        fn();
    }, ms);
    map.set(key, timer);
}

/**
 * Cancel the pending {@link scheduleDebounced} timer for `key`, if any, and drop
 * its bookkeeping entry — the same clear-and-delete a re-schedule does, exposed
 * for eviction. A no-op when nothing is scheduled.
 *
 * Used so a queued action can be revoked when its target goes away (a closed or
 * deleted document whose rescan would otherwise fire against — and resurrect —
 * the gone file).
 */
export function cancelDebounced(map: Map<string, NodeJS.Timeout>, key: string): void {
    const timer = map.get(key);
    if (timer) {
        clearTimeout(timer);
        map.delete(key);
    }
}
