/**
 * The message protocol across the now-stack webview bridge — shared by the host
 * (`src/now-panel.ts`) and the webview client (`src/webview/now-stack/main.tsx`).
 *
 * It lives in `src/lib/` (not `src/webview/`, which the host tsconfig excludes,
 * nor `src/`, which the webview can't typecheck cleanly) so BOTH tsconfigs see
 * it. Types-only — erased at build, so importing it adds nothing to the webview
 * bundle. The row payload arrives in M47 (`render.rows`).
 */

/** Messages the extension posts INTO the webview. */
export type HostToWebview = { type: 'render' };

/** Messages the webview posts back to the extension. */
export type WebviewToHost = { type: 'ready' };
