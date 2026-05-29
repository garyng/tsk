/**
 * Resolve the `tsk.clipboard.bridgePath` setting into a concrete path,
 * or `undefined` when the bridge can't anchor a watch file.
 *
 * - Empty / whitespace raw → `undefined` (treat as "unconfigured / off").
 * - Raw containing `${workspaceFolder}` → substituted. VSCode does NOT
 *   auto-expand this placeholder in arbitrary settings (only in
 *   `tasks.json` / `launch.json`), so we expand it ourselves — same as
 *   `resolveCachePath`. Without a workspace folder the placeholder can't
 *   resolve → `undefined`.
 * - Placeholder-free raw → returned as-is (lets power users point at an
 *   absolute path like `/tmp/tsk-clipboard.txt`).
 *
 * Pure — no I/O. Pair with an `fs`-touch before watching.
 */
export function resolveBridgePath(
    rawSetting: string,
    workspaceFolder: string | undefined,
): string | undefined {
    const trimmed = rawSetting.trim();
    if (!trimmed) return undefined;
    if (trimmed.includes('${workspaceFolder}')) {
        if (!workspaceFolder) return undefined;
        return trimmed.replaceAll('${workspaceFolder}', workspaceFolder);
    }
    return trimmed;
}
