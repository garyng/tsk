/**
 * Central registry for cross-cutting constants used by the tsk extension's
 * glue layer (the non-`lib/` modules that bind pure logic to the VSCode
 * API). Keeping these here — rather than redeclared per-file — gives one
 * place to grep for "what id / key / default does tsk use for X?" and one
 * place to change when a value needs to evolve.
 *
 * **What lives here**
 *   - The language id (`tsk`) used by VSCode's language registry.
 *   - Setting keys + their defaults (`tsk.cache.path`, `tsk.tags.path`,
 *     `tsk.log.level`, `tsk.decorations.priority.opacity`).
 *   - Theme color ids (`tsk.metadata.foreground`, `tsk.navigation.highlight`).
 *   - Debounce / timing defaults that are intentionally tweakable.
 *   - Command ids (`tsk.toggleTodo`, `tsk.goToParent`, …) — added in M13/C
 *     as the `COMMANDS` registry.
 *
 * **What deliberately does NOT live here**
 *   - The `CODICONS` map at `src/lib/codelens-logic.ts` — lib-tier and
 *     tightly coupled to its consumers; moving it here would split a
 *     single source of truth across two modules.
 *   - Regex patterns — stay co-located with their parser in
 *     `src/lib/parser.ts` and `src/lib/decorations.ts` for the same
 *     reason.
 *   - The SQL schema in `src/lib/db.ts` — already an internal `SCHEMA`
 *     constant; lib-tier and not re-used elsewhere.
 *   - Feature-local consts like `TRIGGER_CHARACTER = '#'` in
 *     `tags-completion.ts` — single-consumer, not cross-cutting.
 *
 * **Setting-key convention**
 *
 * Each user-visible setting has *two* constants kept side-by-side:
 *   - `*_SETTING` — the full dotted name (`tsk.cache.path`). Used with
 *     `affectsConfiguration(...)` and matches the entry in
 *     `package.json#contributes.configuration.properties`.
 *   - `*_KEY` — the sub-key (`cache.path`, no `tsk.` prefix). Used with
 *     `vscode.workspace.getConfiguration('tsk').get(...)`.
 *
 * Both literals are kept here even if only one is currently referenced
 * elsewhere — together they document the full setting contract.
 *
 * **TODO — configurability**
 *
 * Entries marked `// TODO: configurable` are candidates to be exposed as
 * user settings in a future plan (`2026-XX-XX_tsk-configurable-constants.md`).
 * They are values where a power-user might reasonably want a different
 * trade-off (e.g. debounce latency vs. responsiveness) but where we haven't
 * yet seen the demand. When such a setting lands, the constant here becomes
 * the *default* and the lookup site reads
 * `getConfiguration('tsk').get(..., DEFAULT)` instead.
 */

// ── Identifiers ─────────────────────────────────────────────────────────────

/**
 * VSCode language id for `.tsk` files. Matches
 * `package.json#contributes.languages[0].id` and the `editorLangId == 'tsk'`
 * clause in every keybinding `when` expression.
 */
export const TSK_LANGUAGE_ID = 'tsk';

/**
 * Display name of the Output channel created at activation (`Output → Tsk`).
 * Shares the `'tsk'` literal with {@link TSK_LANGUAGE_ID} today but is
 * semantically distinct — this string is user-facing UI, the other is a
 * VSCode-internal language registry key.
 */
export const OUTPUT_CHANNEL_NAME = 'tsk';

/**
 * Identifier of the diagnostic collection. Surfaces in the Problems panel
 * under the "Source" column. Same `'tsk'` literal, again semantically
 * distinct from {@link TSK_LANGUAGE_ID}.
 */
export const DIAGNOSTIC_SOURCE = 'tsk';

// ── Settings ────────────────────────────────────────────────────────────────

export const CACHE_PATH_SETTING = 'tsk.cache.path';
export const CACHE_PATH_KEY = 'cache.path';

export const TAGS_PATH_SETTING = 'tsk.tags.path';
export const TAGS_PATH_KEY = 'tags.path';

export const LOG_LEVEL_SETTING = 'tsk.log.level';
export const LOG_LEVEL_KEY = 'log.level';

export const PRIORITY_OPACITY_SETTING = 'tsk.decorations.priority.opacity';
export const PRIORITY_OPACITY_KEY = 'decorations.priority.opacity';

export const CLIPBOARD_BRIDGE_ENABLED_SETTING = 'tsk.clipboard.bridgeEnabled';
export const CLIPBOARD_BRIDGE_ENABLED_KEY = 'clipboard.bridgeEnabled';

export const CLIPBOARD_BRIDGE_PATH_SETTING = 'tsk.clipboard.bridgePath';
export const CLIPBOARD_BRIDGE_PATH_KEY = 'clipboard.bridgePath';

// ── Defaults ────────────────────────────────────────────────────────────────

/**
 * Default priority opacity used when the user hasn't overridden the setting.
 * Mirrors the `default` in `package.json#contributes.configuration` so the
 * fallback in code stays consistent with the schema.
 */
export const DEFAULT_PRIORITY_OPACITY = 0.15;

/** Default log level used when the setting is missing or invalid. */
export const DEFAULT_LOG_LEVEL = 'info';

/**
 * Default watch-file path for the clipboard bridge. Mirrors the `default`
 * in `package.json`; `${workspaceFolder}` is expanded at runtime by
 * `resolveBridgePath` (VSCode doesn't auto-expand it in plain settings).
 * Lives under `.vscode/tsk/` alongside `cache.db` + `tags.yml` so all of
 * tsk's workspace-local artifacts share one folder.
 */
export const DEFAULT_CLIPBOARD_BRIDGE_PATH = '${workspaceFolder}/.vscode/tsk/clipboard-bridge.txt';

/** The clipboard bridge is opt-in — off unless the user enables it. */
export const DEFAULT_CLIPBOARD_BRIDGE_ENABLED = false;

// ── Theme color ids ─────────────────────────────────────────────────────────

export const METADATA_FOREGROUND_COLOR_ID = 'tsk.metadata.foreground';
export const NAVIGATION_HIGHLIGHT_COLOR_ID = 'tsk.navigation.highlight';

// ── Timing ──────────────────────────────────────────────────────────────────

/**
 * Debounce interval (ms) applied to per-URI cache rescans and decoration
 * refreshes on document change. Long enough to coalesce a typing burst,
 * short enough that a save-driven reflow feels immediate.
 *
 * TODO: configurable
 */
export const DOC_CHANGE_DEBOUNCE_MS = 300;

/**
 * Poll interval (ms) for the clipboard-bridge `fs.watchFile` watcher.
 * We poll by stat rather than `fs.watch` (inotify) because the common
 * writer is VS Code's editor save, which writes a temp file and renames
 * it over the target — swapping the inode and going invisible to an
 * inode-bound `fs.watch`. Stat-polling the path follows the rename, and
 * also works on devcontainer / WSL2 mounts where inotify is unreliable.
 * 300ms keeps the paste-after-write feel sub-second; stat-polling one
 * small file at this cadence is negligible CPU.
 */
export const CLIPBOARD_BRIDGE_POLL_INTERVAL_MS = 300;

// ── Commands ────────────────────────────────────────────────────────────────

/**
 * Commands declared in `package.json#contributes.commands` and exposed
 * in the Command Palette. Each value matches a `command` entry in the
 * package manifest; the cross-check in `constants.test.ts` enforces that
 * the two stay in sync.
 *
 * Consumers reference these by short key (`COMMANDS.toggleTodo`) so a
 * rename touches one file. The literal type lets TypeScript narrow on
 * the discriminated union in `LensDescriptor.args` (added in M15/B).
 */
export const COMMANDS = {
    rebuildCache: 'tsk.rebuildCache',
    findAllTasksByTag: 'tsk.findAllTasksByTag',
    toggleTodo: 'tsk.toggleTodo',
    toggleInprogress: 'tsk.toggleInprogress',
    toggleCompleted: 'tsk.toggleCompleted',
    toggleCancelled: 'tsk.toggleCancelled',
    toggleNote: 'tsk.toggleNote',
    toggleP1: 'tsk.toggleP1',
    toggleP2: 'tsk.toggleP2',
    toggleP3: 'tsk.toggleP3',
    copyTaskId: 'tsk.copyTaskId',
    toggleMoved: 'tsk.toggleMoved',
    toggleRelatedTo: 'tsk.toggleRelatedTo',
    toggleDependsOn: 'tsk.toggleDependsOn',
    toggleParent: 'tsk.toggleParent',
    handleEnter: 'tsk.handleEnter',
    handleTab: 'tsk.handleTab',
    handleShiftTab: 'tsk.handleShiftTab',
    installClipboardBridgeSkill: 'tsk.installClipboardBridgeSkill',
} as const satisfies Record<string, `tsk.${string}`>;

/**
 * Commands registered programmatically and invoked only via CodeLens
 * descriptors (see `lib/codelens-logic.ts`). Deliberately NOT in
 * `package.json#contributes.commands` — they require arguments only the
 * lens layer can supply, so surfacing them in the Command Palette would
 * just produce broken invocations.
 *
 * Kept separate from `COMMANDS` so the package.json cross-check stays
 * sharp ("every contributed command is in `COMMANDS`" — without false
 * positives from internal ids).
 */
export const INTERNAL_COMMANDS = {
    goToParent: 'tsk.goToParent',
    goToDependsOn: 'tsk.goToDependsOn',
    goToRelated: 'tsk.goToRelated',
    findAllChildren: 'tsk.findAllChildren',
    findAllDependents: 'tsk.findAllDependents',
    findAllRelated: 'tsk.findAllRelated',
    codelensMissing: 'tsk.codelens.missing',
    /**
     * Quick-fix backing for broken-ref diagnostics (M20/C). Takes
     * `(uri: vscode.Uri, line: number, key: 'parent' | 'dependsOn' | 'relatedTo')`,
     * opens the task picker, and rewrites `@<key>:<picked-id>` on the
     * given line. Hidden from the palette because the args make no
     * sense outside a code-action invocation.
     */
    replaceBrokenReference: 'tsk.replaceBrokenReference',
} as const satisfies Record<string, `tsk.${string}`>;
