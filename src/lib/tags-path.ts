/**
 * Resolve the `tsk.tags.path` setting into a concrete absolute path, or
 * `undefined` when no tags file can be located.
 *
 * - No workspace folder → `undefined` (single-file `.tsk` open: no
 *   workspace-relative tags.yml to load).
 * - Empty / whitespace raw → `undefined` (user disabled the path by
 *   blanking the setting).
 * - Raw contains `${workspaceFolder}` → substituted. VSCode does not
 *   auto-expand this placeholder in arbitrary settings (only in
 *   `tasks.json` / `launch.json`), so we must do it ourselves — same
 *   reasoning as the cache-path resolver.
 * - Raw without the placeholder → returned as-is, so power users can
 *   point at an absolute path or a path inside a different workspace.
 *
 * Pure — no I/O. The activation layer probes the resolved path with
 * `vscode.workspace.fs.readFile`.
 */
export function resolveTagsPath(
    rawSetting: string,
    workspaceFolder: string | undefined,
): string | undefined {
    if (!workspaceFolder) return undefined;
    const trimmed = rawSetting.trim();
    if (!trimmed) return undefined;
    return trimmed.replace('${workspaceFolder}', workspaceFolder);
}
