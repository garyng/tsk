/**
 * The CSS variable a webview reads a theme colour from. VS Code names it
 * `'vscode-' + id.replace('.', '-')` — the first dot only — so
 * `tsk.marker.completed` is `--vscode-tsk-marker.completed`, the second dot
 * escaped to be read as CSS.
 */
export function themeColorVar(colorId: string): string {
    return `--vscode-${colorId.replace('.', '-').replaceAll('.', '\\.')}`;
}
