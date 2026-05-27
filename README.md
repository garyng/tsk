# tsk

A markdown-based task manager VSCode extension. Works on `.tsk` files, enriching markdown task lists with inline metadata, tags, relationship graphs, code lenses, and a queryable cache.

Currently in **early development (M0–M5 complete)** — the extension activates against `.tsk` files, applies its TextMate grammar, parses tasks/metadata/tags into a queryable SQLite cache, surfaces scan-time warnings as both Output channel logs and editor diagnostics, decorates marker triplets and priority lines, and provides 13 toggle/copy commands with keybindings (marker / priority / relationship / picker-driven). Codelens, Enter/Tab handling, and tag autocompletion land milestone-by-milestone. The implementation plan lives at [`plans/2026-05-24_tsk.md`](../../plans/2026-05-24_tsk.md).

## Development

```sh
npm install            # one-time
npm run build:host     # produces dist/extension.cjs via Vite (library mode, CJS)
npm run dev:host       # same, in watch mode
```

Open the repo in VS Code and pick **Run and Debug → Run Extension** to launch a development host with this extension loaded.

## Tests

```sh
npm test               # vitest unit tests (src/**/*.test.ts)
npm run test -- --coverage   # with v8 coverage report
npm run test:e2e       # @vscode/test-cli — compiles tests, builds host, launches VSCode
```

The e2e runner auto-wraps in `xvfb-run` when available (devcontainer/CI) and otherwise relies on a real display (macOS, WSL2 host, etc.).

## Lint & format

```sh
npm run lint           # biome check .
npm run format         # biome format --write .
```

## Packaging

```sh
npm run package        # builds, then runs @vscode/vsce → produces tsk-<version>.vsix
```

## Layout

```
src/
  extension.ts          # activate/deactivate, cache + decoration wire-up, command + watcher registration
  toggle-commands.ts    # applyEdit + registerToggleCommands / registerCopyTaskIdCommand / registerRelationshipCommands
  picker.ts             # pickTaskId — InputBox prefilled from clipboard, "Browse tasks…" QuickPick
  lib/                  # pure logic — unit-tested
    markers.ts          # MARKERS registry — single source of truth for marker name/symbols/color/scope
    priorities.ts       # PRIORITIES registry — level/rgb/label
    parser.ts           # parseLine, parseDocument; regex char class derived from MARKERS
    metadata.ts         # extractMetadata, serializeMetadata, replaceMetadata
    toggle.ts           # swapMarker, wrapAsTask, unwrapTask, (set|remove|toggle)MetadataEntry
    toggle-mutators.ts  # 10 toggle mutator factories composing toggle.ts + parser.ts
    picker-logic.ts     # sanitizeClipboardForId, taskToPickItem (vscode-free pieces of the picker)
    decorations.ts      # RangeLike + computeMarkerRanges + computePriorityRanges + priorityBackgroundColor
    cache.ts            # CacheService — orchestrates parser + db with warnings
    db.ts               # node:sqlite wrapper with schema, prepared statements
    cache-path.ts       # ${workspaceFolder} resolver + in-memory fallback
    ids.ts              # nanoid + seedable PRNG for @id generation
    time.ts             # ISO-local timestamp helper
    logger.ts           # leveled Output channel logger
syntaxes/
  tsk.tmLanguage.json   # grammar that includes text.html.markdown
tests/
  e2e/                  # @vscode/test-cli suites — run inside a real VSCode host
    fixtures/           # workspace fixtures opened by the e2e runner
docs/
  demo.tsk              # living end-to-end showcase, grown by each milestone
```

## Cache layer (M3)

On activation, the extension scans `**/*.tsk` (excluding `**/node_modules/**`) and indexes tasks into a SQLite cache:

- Default location: `${workspaceFolder}/.vscode/tsk/cache.db`. Configurable via `tsk.cache.path`. Falls back to in-memory when no workspace folder is open. (M8's `tags.yml` lives next to it under `.vscode/tsk/`.)
- WAL mode + relaxed `synchronous` + foreign-key cascades. Schema is `IF NOT EXISTS`, so reopening preserves data.
- File events (FileSystemWatcher, doc save, debounced doc change) trigger per-file rescans inside a `Db` transaction.
- Run **Tsk: Rebuild Cache** to purge and rerun the initial scan.

**Warnings convention.** Every user-facing warning (today: duplicate `@id`, task without `@id`) surfaces in *both* the `tsk` Output channel and in editor diagnostics (`Warning` severity, listed in the Problems panel). The same convention applies to every future warning category.

## Decorations (M4)

Two layers of editor decorations on `.tsk` documents:

- **Marker triplet color.** Each `[X]` is colored per marker — `[/]` blue, `[x]` green, `[>]` orange, `[!]` gray (struck through), `[n]` purple; `[ ]` keeps the editor's default foreground. Hues come from `contributes.colors` entries (`tsk.marker.{inprogress,completed,moved,cancelled,notes}`); users can override per workspace via `workbench.colorCustomizations`.
- **Priority line background.** `@priority:1` paints the line red, `:2` yellow, `:3` blue. Opacity is settable via `tsk.decorations.priority.opacity` (default `0.15`, range 0–1); changes apply live without a reload.
- **Dimmed inline metadata.** Every `<!-- @key:value -->` block is dimmed via `tsk.metadata.foreground` so the comments recede into the editor background. Phase 2 surfaces the parsed values via hover-on-task; until then the dim is the "present but quiet" hint that those comments are extension-managed bookkeeping.

Decorations apply on editor focus, after save, and on a 300 ms debounce after text changes — independent from the cache rescan debounce. Definitions live in the `MARKERS` / `PRIORITIES` registries (`src/lib/markers.ts` / `src/lib/priorities.ts`); adding a new marker is a single registry entry plus mirroring into `package.json` and the grammar JSON (drift-tested).

## Toggle commands (M5)

Thirteen palette-registered commands operate on the cursor line (or every unique cursor line in multi-cursor mode). Every command builds a single `WorkspaceEdit` so one Ctrl+Z reverts the whole operation.

| Keybinding   | Command                                       | Behavior |
|--------------|-----------------------------------------------|----------|
| `Alt+A`      | `tsk.toggleTodo`                              | Wrap a plain/empty line as `[ ]` with `@id` + `@created`; unwrap an empty todo. |
| `Alt+S`      | `tsk.toggleInprogress`                        | Swap marker to `[/]` + `@started`; toggling again reverts. |
| `Alt+C`      | `tsk.toggleCompleted`                         | `[x]` + `@completed`. |
| `Alt+X`      | `tsk.toggleCancelled`                         | `[!]` + `@cancelled`. |
| `Alt+N`      | `tsk.toggleNote`                              | Wrap/unwrap as `[n]`. |
| `Alt+M`      | `tsk.toggleMoved`                             | Picker → `[>]` + `@movedTo` + `@moved`. Empty submission writes only `@moved` (moved-elsewhere). Toggling again reverts. |
| `Alt+R / D / P` | `tsk.toggleRelatedTo` / `DependsOn` / `Parent` | Absent → picker → write; present → silently remove. |
| `Alt+1 / 2 / 3` | `tsk.toggleP1` / `P2` / `P3`                | Toggle `@priority:N`; switching levels overwrites in one step. |
| `` Alt+` ``  | `tsk.copyTaskId`                              | Copy the current task's `@id` to the system clipboard. |

**Task-id picker** (M5/D, originally planned as M6): the four picker-driven commands open an InputBox prefilled with the sanitized first token of clipboard text. Click the **"Browse tasks…"** button (search icon) to switch to a QuickPick of every cached task across the workspace.

**Keybinding caveats**:
- `Alt+1`/`Alt+2`/`Alt+3` are globally bound to "Focus N-th Editor Group" in VSCode defaults. Our `when: editorLangId == 'tsk'` clause makes the toggle win inside `.tsk` files; the editor-group focus still works elsewhere.
- `` Alt+` `` uses the backtick key, which varies by keyboard layout — UK / DE / FR users may need to rebind via the Keyboard Shortcuts editor.
- Other Alt-letter combos depend on installed extensions and themes; the language-scoped `when` clause prevents `.tsk` toggles from leaking outside, but third-party extensions binding the same chord with an equally specific `when` clause could clash.

## Conventions

- Pure logic in `src/lib/**` is unit-tested with vitest; user-visible behavior is e2e-tested with `@vscode/test-cli`. A feature is incomplete without both.
- After every user-visible feature lands, `docs/demo.tsk` is updated to exercise it.
- Detailed scoped rules: see [`CLAUDE.md`](./CLAUDE.md).
