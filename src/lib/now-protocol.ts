/**
 * The message protocol across the now-stack webview bridge — shared by the host
 * (`src/now-panel.ts`) and the webview client (`src/webview/now-stack/main.tsx`).
 *
 * It lives in `src/lib/` (not `src/webview/`, which the host tsconfig excludes,
 * nor `src/`, which the webview can't typecheck cleanly) so BOTH tsconfigs see
 * it. Types-only — erased at build, so importing it (and the `NowRowView` it
 * references) adds nothing to the webview bundle.
 */

import type { NowRowView } from './now-row';

/**
 * Messages the extension posts INTO the webview. `render` carries the fully
 * resolved, linear-compaction rows (built host-side by `buildNowTreeView`); the
 * webview reconstructs the grida tree from them and renders.
 */
export type HostToWebview = { type: 'render'; rows: NowRowView[] };

/** Messages the webview posts back to the extension. */
export type WebviewToHost = { type: 'ready' };
