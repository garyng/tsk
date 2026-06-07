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

/**
 * Messages the webview posts back to the extension. `ready` triggers the first
 * render; the rest are user actions the panel routes to the now-tree commands
 * (`jump` carries a task `@id`; the node mutators a tree `entryId`;
 * `back`/`pruneOffPath`/`clear` act on the current / whole tree). `revealCurrent`
 * is handled entirely webview-side (grida `reveal()`), so it isn't here.
 */
export type WebviewToHost =
    | { type: 'ready' }
    | { type: 'jump'; id: string }
    | { type: 'switchTo'; entryId: string }
    | { type: 'remove'; entryId: string }
    | { type: 'pruneSubtree'; entryId: string }
    | { type: 'pruneChildren'; entryId: string }
    | { type: 'back' }
    | { type: 'pruneOffPath' }
    | { type: 'clear' };
