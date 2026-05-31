import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Sentinel passed straight through to `node:sqlite` — opens an in-memory DB
 * with no persistence. Used when no workspace folder is available to anchor
 * a real on-disk cache.
 */
export const IN_MEMORY = ':memory:';

/**
 * Resolve the `tsk.cache.path` setting into a concrete sqlite path.
 *
 * - No workspace folder → always `:memory:` (single-file `.tsk` opened
 *   directly: we cache in RAM, skip persistence).
 * - Workspace folder + raw containing `${workspaceFolder}` → substituted.
 *   VSCode does NOT auto-expand this placeholder in arbitrary settings
 *   (only in `tasks.json` / `launch.json`), so we must do it ourselves.
 * - Workspace folder + raw without the placeholder → returned as-is (lets
 *   power users point at an absolute path like `/var/cache/tsk.db`).
 * - Empty / whitespace raw → falls back to `:memory:`, treating it as
 *   "user didn't configure anything useful".
 *
 * Pure — no I/O. Pair with `ensureCacheParentDir` before opening.
 */
export function resolveCachePath(rawSetting: string, workspaceFolder: string | undefined): string {
    if (!workspaceFolder) return IN_MEMORY;
    const trimmed = rawSetting.trim();
    if (!trimmed) return IN_MEMORY;
    return trimmed.replace('${workspaceFolder}', workspaceFolder);
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
