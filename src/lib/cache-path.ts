import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Sentinel passed straight through to `node:sqlite` — opens an in-memory DB
 * with no persistence. Used when no workspace folder is available to anchor
 * a real on-disk cache.
 */
export const IN_MEMORY = ':memory:';

/** What a database path's placeholders stand for; undefined when there's no workspace. */
export interface PathPlaces {
    /** The first workspace folder: `${workspaceFolder}`. */
    readonly workspaceFolder: string | undefined;
    /** The extension's folder in VS Code's storage for this workspace (`context.storageUri`): `${workspaceStorage}`. */
    readonly workspaceStorage: string | undefined;
}

/**
 * Resolve the `tsk.cache.path` / `tsk.state.path` setting into a concrete sqlite path.
 *
 * - No workspace folder → always `:memory:` (single-file `.tsk` opened
 *   directly: we cache in RAM, skip persistence).
 * - `${workspaceFolder}` and `${workspaceStorage}` → substituted. VS Code
 *   does NOT expand placeholders in arbitrary settings (only in `tasks.json` /
 *   `launch.json`), so we must do it ourselves. One with nothing to stand for
 *   → `:memory:`.
 * - No placeholder → returned as-is (lets power users point at an absolute
 *   path like `/var/cache/tsk.db`).
 * - Empty / whitespace raw → falls back to `:memory:`, treating it as
 *   "user didn't configure anything useful".
 *
 * Pure — no I/O. Pair with `ensureCacheParentDir` before opening.
 */
export function resolveCachePath(rawSetting: string, places: PathPlaces): string {
    if (!places.workspaceFolder) return IN_MEMORY;
    const trimmed = rawSetting.trim();
    if (!trimmed) return IN_MEMORY;
    if (trimmed.includes('${workspaceStorage}') && !places.workspaceStorage) return IN_MEMORY;
    return trimmed
        .replace('${workspaceFolder}', places.workspaceFolder)
        .replace('${workspaceStorage}', places.workspaceStorage ?? '');
}

/**
 * Create the parent directory of a cache path if it doesn't already exist.
 * No-op for `:memory:`. Recursive mkdir is idempotent — safe to call every
 * time we open the cache.
 */
export function ensureCacheParentDir(path: string): void {
    if (path === IN_MEMORY) return;
    mkdirSync(dirname(path), { recursive: true });
}
