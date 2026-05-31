import type { LogLevel } from './logger';

/**
 * Pure parsers / validators for `tsk.*` setting values. The activation layer
 * reads the raw configured value (`getConfiguration('tsk').get(...)`) and hands
 * it here; these functions own the validation + clamping, so the logic is
 * unit-testable without a VSCode host. No `vscode` import — lib-tier.
 */

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Coerce a raw `tsk.log.level` string to a valid {@link LogLevel}. The manifest
 * enum blocks anything else in the Settings UI; this guards a hand-edited
 * settings.json by recovering an unknown value to the safe `'info'` level.
 */
export function parseLogLevel(raw: string): LogLevel {
    return (LOG_LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : 'info';
}

/**
 * Clamp a raw `tsk.decorations.priority.opacity` value to [0, 1]. The settings
 * JSON schema enforces the range in the UI; this defends against a hand-edited
 * value outside it.
 */
export function clampPriorityOpacity(raw: number): number {
    return Math.max(0, Math.min(1, raw));
}

/**
 * Validate a raw `tsk.editor.changeDebounceMs` value (ms). The manifest declares
 * a default of 300 and a [0, 5000] integer range enforced in the Settings UI;
 * this guards a hand-edited settings.json — a non-finite value degrades to 0 (no
 * debounce), otherwise the value is clamped to [0, 5000] and rounded.
 */
export function parseChangeDebounceMs(raw: number): number {
    if (!Number.isFinite(raw)) return 0;
    return Math.max(0, Math.min(5000, Math.round(raw)));
}
