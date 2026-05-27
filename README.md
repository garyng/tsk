# tsk

A markdown-based task manager VSCode extension. Works on `.tsk` files, enriching markdown task lists with inline metadata, tags, relationship graphs, code lenses, and a queryable cache.

**Phase 1 complete (M0–M12)** — the extension activates against `.tsk` files, applies its TextMate grammar, parses tasks/metadata/tags into a queryable SQLite cache, surfaces scan-time warnings as both Output channel logs and editor diagnostics, decorates marker triplets and priority lines, provides 13 toggle/copy commands with keybindings, replicates MD-AIO's Enter/Tab/Shift+Tab list semantics with metadata-preserving splits, offers tag autocompletion + find-all-tasks-by-tag driven by a workspace-local `tags.yml`, renders relationship code lenses (parent/children/dependsOn/dependents/relatedTo/related) on every canonical task with navigate + peek commands, and tints the target line after every navigate until you move the cursor or jump again. Functionally shippable; clean-profile `.vsix` smoke install + Marketplace screenshots tracked as pre-publication polish. The implementation plan lives at [`plans/2026-05-24_tsk.md`](../../plans/2026-05-24_tsk.md).

## Development

```sh
npm install            # one-time
npm run build:host     # produces dist/extension.cjs via Vite (library mode, CJS)
npm run dev:host       # same, in watch mode
```

Open the repo in VS Code and pick **Run and Debug → Run Extension** to launch a development host with this extension loaded.

After a fresh `npm run build:host`, the existing dev host process is still running the *previous* bundle — VSCode doesn't auto-reload extensions. In the dev host window, run **Developer: Restart Extension Host** (Command Palette) to pick up the new build.

## Tests

```sh
npm test               # vitest unit tests (src/**/*.test.ts)
npm run test -- --coverage   # with v8 coverage report; fails under 80% on src/lib/**
npm run test:e2e       # @vscode/test-cli — compiles tests, builds host, launches VSCode
```

The e2e runner auto-wraps in `xvfb-run` when available (devcontainer/CI) and otherwise relies on a real display (macOS, WSL2 host, etc.). The coverage gate is opt-in (instrumentation slows iteration) — bare `npm test` skips it; the `-- --coverage` invocation enforces.

## Adding an e2e test

End-to-end tests live in `tests/e2e/**/*.test.ts` and run inside a real VSCode host driven by `@vscode/test-cli`. The pattern is mature enough that adding a new test usually means picking one of the recipes below.

### Acquire the extension API

```ts
import * as vscode from 'vscode';
import type { TskExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'garyng.tsk';

suite('my feature', () => {
    let api: TskExtensionApi;
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<TskExtensionApi>(EXTENSION_ID);
        api = await ext!.activate();
    });
    // ...
});
```

The returned `TskExtensionApi` carries the test-only introspection methods listed in `src/extension.ts`: `counts()`, `findTaskById(id)`, `listAllTags()`, `getDecorations(uri)`, `getTags()`, `reloadTags()`, `lookupGraph(id)`, `getNavigationHighlight()`. Each one delegates to live state in the activation layer, so assertions read the same values the extension would render.

### Fixtures

Workspace fixtures live in `tests/e2e/fixtures/workspace/`. The host opens this folder as its workspace root, so cache + graph + tag scans see every `.tsk` file there. Today: `sample.tsk` (M3 deterministic content), `dup.tsk` (graph + dup-id), `.vscode/tsk/tags.yml` (tag completion fixture).

Adding a new `.tsk` fixture changes the cache counts — update the `cache.test.ts` `counts.files` / `counts.tasks` assertions in lockstep.

### Robust assertion patterns (covered)

- **Provider outputs** via the built-in `vscode.execute…` commands:
  ```ts
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider', uri,
  );
  const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider', uri, position, '#',
  );
  ```
- **Command registration** via `vscode.commands.getCommands(true)`.
- **Keybinding / configuration drift** via `ext.packageJSON.contributes.keybindings` and `.configuration.properties`.
- **State** via the API methods above.
- **Document edits** via `editor.selection = …` + `vscode.commands.executeCommand('tsk.foo')` + reading `doc.getText()` back. Use `await new Promise(resolve => setImmediate(resolve))` to yield to VSCode's event loop between an action and its assertion.

### Not covered (don't try to assert these)

- **Visual rendering of decorations** — VSCode doesn't expose what `setDecorations` actually drew. The extension records every applied range in a snapshot accessible via `api.getDecorations(uri)`; that's the proxy you assert.
- **QuickPick contents** at the UI level — the picker resolves to a value only when the user selects, and the test can't simulate that without driving the input box.
- **Info / warning toasts** (`showInformationMessage` / `showWarningMessage`) — no programmatic interception. Test the precondition (state should be X before the toast fires) and trust the toast call.
- **True user input kinds** — `editor.selection = …` and `vscode.commands.executeCommand` fire `TextEditorSelectionChangeKind.Command`. There's no way to synthesize `Keyboard` or `Mouse` from the test runner; if your test depends on that distinction (e.g., the navigation-highlight kind filter), factor a pure helper and unit-test the branching logic separately.

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
  extension.ts                # activate/deactivate, cache + decoration wire-up, command + watcher registration
  toggle-commands.ts          # applyEdit + registerToggleCommands / registerCopyTaskIdCommand / registerRelationshipCommands
  list-edit-commands.ts       # registerListEditCommands — Enter / Tab / Shift+Tab handlers + default fallback
  picker.ts                   # pickTaskId — InputBox prefilled from clipboard, "Browse tasks…" QuickPick
  tags-loader.ts              # createTagsLoader — reads tags.yml, wires FileSystemWatcher + config listener
  tags-completion.ts          # registerTagsCompletionProvider — #-triggered CompletionItemProvider
  find-tasks-by-tag.ts        # registerFindAllTasksByTagCommand — QuickPick → workbench.action.findInFiles
  codelens.ts                 # registerCodelens — TskCodeLensProvider + 7 navigate/peek/missing commands
  navigation-highlight.ts     # NavigationHighlight — persistent line decoration after a goTo* navigate
  diagnostics-manager.ts      # DiagnosticsManager — merges cache scan warnings + graph dup reports per-file
  lib/                        # pure logic — unit-tested
    markers.ts                # MARKERS registry — single source of truth for marker name/symbols/color/scope
    priorities.ts             # PRIORITIES registry — level/rgb/label
    parser.ts                 # parseLine, parseDocument; regex char class derived from MARKERS
    metadata.ts               # extractMetadata, serializeMetadata, replaceMetadata
    toggle.ts                 # swapMarker, wrapAsTask, unwrapTask, (set|remove|toggle)MetadataEntry
    toggle-mutators.ts        # 10 toggle mutator factories composing toggle.ts + parser.ts
    list-edit.ts              # compute(Enter|Tab|ShiftTab)Edit — pure list-edit logic + metadata pinning
    picker-logic.ts           # sanitizeClipboardForId, taskToPickItem (vscode-free pieces of the picker)
    decorations.ts            # RangeLike + computeMarkerRanges + computePriorityRanges + priorityBackgroundColor
    cache.ts                  # CacheService — orchestrates parser + db with warnings
    db.ts                     # node:sqlite wrapper with schema, prepared statements
    cache-path.ts             # ${workspaceFolder} resolver + in-memory fallback
    tags-config.ts            # TagDef, parseTagsYaml, expandImplicitParents, mergeTagDefs
    tags-path.ts              # resolveTagsPath — ${workspaceFolder} substitution for tsk.tags.path
    tags-completion-logic.ts  # findTagPrefixContext — pure #-trigger context detector
    tags-find-logic.ts        # tagsToPickItems, buildFindInFilesArgs
    graph.ts                  # buildGraph, GraphNode, DuplicateIdReport — pure relationship graph + dup detection
    graph-service.ts          # GraphService — scoped invalidation over the pure builder + occurrences index
    codelens-logic.ts         # computeLensesForTask — pure lens descriptors (forward, inverse, dangling)
    ids.ts                    # nanoid + seedable PRNG for @id generation
    time.ts                   # ISO-local timestamp helper
    logger.ts                 # leveled Output channel logger
syntaxes/
  tsk.tmLanguage.json   # grammar that includes text.html.markdown
tests/
  e2e/                  # @vscode/test-cli suites — run inside a real VSCode host
    fixtures/           # workspace fixtures opened by the e2e runner — includes .vscode/tsk/tags.yml
docs/
  demo.tsk              # living end-to-end showcase, grown by each milestone
  .vscode/tsk/tags.yml  # demo-side tag descriptions — picked up by the Extension Development Host
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

## List editing (M7)

Enter / Tab / Shift+Tab inside a `.tsk` file are intercepted to mimic MD-AIO's list semantics with one tsk-specific extension: inline metadata never gets pushed to the next line. Pure logic in `src/lib/list-edit.ts`; activation handlers in `src/list-edit-commands.ts`.

| Key       | Behavior                                                                                              |
|-----------|-------------------------------------------------------------------------------------------------------|
| `Enter`   | Cursor at end-of-content (before `<!--` or end of line) → continue the list with a fresh empty task (new `@id` + `@created`). Cursor mid-content → split at the cursor; **metadata stays on the original line**. On an empty task → outdent (col > 0) or remove the whole task (col 0). |
| `Tab`     | On an empty task → indent one level (spaces or tab per editor settings). Otherwise → default editor Tab.   |
| `Shift+Tab` | On any task with indent → outdent one level. Otherwise → default editor outdent.                    |

**`when` clause** on every keybinding: `editorLangId == 'tsk' && editorTextFocus && !suggestWidgetVisible && !inSnippetMode`. So Enter accepts an IntelliSense suggestion when one is visible, and Tab advances a snippet placeholder when one is active — the list-edit handler stays out of the way.

**Continuation marker is always `[ ]`** — pressing Enter at the end of a `[x]` completed task still creates a fresh `[ ]` todo on the next line. Matches MD-AIO.

## Tags (M8)

Tags use the `#tag` and `#tag/sub/leaf` syntax inside `.tsk` files (per the M2 parser). M8 plugs two user surfaces on top:

- **`#`-triggered completion.** Inside any `.tsk` editor, type `#` (or `#partial`) and a `CompletionItemProvider` surfaces every known tag. Items merge two sources: tags declared in the workspace `tags.yml` (with descriptions, shown as the item `detail`) and tags discovered in `.tsk` files via the M3 cache (plus implicit `/`-separated parents, so `#project/tsk` automatically contributes `#project` to the list).
- **`Alt+T` find-all-tasks-by-tag.** Opens a `QuickPick` of every known tag (searchable by name *and* yaml description via `matchOnDescription: true`), then dispatches `workbench.action.findInFiles` with `#<tag>` pre-populated and the include glob scoped to `*.tsk`. You land inside VSCode's built-in Search Editor with Ctrl+Click navigation, regex/case toggles, and multi-result preview already wired up — no custom result document needed.

**`tags.yml` location.** Default `${workspaceFolder}/.vscode/tsk/tags.yml` (configurable via `tsk.tags.path`). Both schema forms are accepted:

```yml
<tag>: <description>            # string shorthand
<tag>:                           # object form
    description: <description>
    parent: <tag>
```

Empty / missing / malformed `tags.yml` is tolerated — the loader returns an empty map rather than throwing, and a `FileSystemWatcher` re-reads on create/change/delete. A "warn if file exists but parses to empty" log surfaces gross errors in the Output channel.

**Find-in-Files semantics.** The `#tag` query is a literal substring, so `#project` will also match lines containing `#project/tsk`. Read this as a feature — parent-tag searches naturally include their children. For exact matches, toggle regex in the Search bar (e.g. `(?<![\w/-])#project(?![\w/-])`).

**Keybinding caveats** (Alt+T joins the existing list):
- Third-party extensions with an equally specific `when` clause (`editorLangId == 'tsk' && editorTextFocus`) could shadow Alt+T inside `.tsk` files; the toggle bindings face the same constraint.
- Some EU keyboard layouts treat `Alt+letter` as a typed-character chord and may need a rebind via the Keyboard Shortcuts editor.

## Codelens (M9)

Every task with relationship metadata grows code lenses showing forward edges (`parent: <id>` / `dependsOn: <id>` / `relatedTo: <id>`) and inverse edges (`children: N` / `dependents: N` / `related: N`). Pure lens computation lives in `src/lib/codelens-logic.ts`; the activation handlers and provider in `src/codelens.ts`. The graph itself is owned by `GraphService` (`src/lib/graph-service.ts`), which keeps a per-id occurrences index + per-file id index and rebuilds the snapshot from the pure `buildGraph` builder on every cache change.

Each lens title is prefixed with a [codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html) hinting the relationship type:

| Lens                       | Command                  | Behavior |
|----------------------------|--------------------------|----------|
| `parent: <id>`             | `tsk.goToParent`         | Open the parent's file at the parent's line. |
| `children: N`              | `tsk.findAllChildren`    | Peek view of every task pointing at this one via `@parent`. |
| `dependsOn: <id>`          | `tsk.goToDependsOn`      | Open the depended-on task's location. |
| `dependents: N`            | `tsk.findAllDependents`  | Peek view of every task `@dependsOn`-pointing here. |
| `relatedTo: <id>`          | `tsk.goToRelated`        | Open the related task's location. |
| `related: N`               | `tsk.findAllRelated`     | Peek view of every task `@relatedTo`-pointing here. |
| `<key>: <id> (missing)`    | `tsk.codelens.missing`   | Pop an info toast — the referenced `@id` isn't in the workspace. |

The exact codicon per relationship type lives in `CODICONS` in `src/lib/codelens-logic.ts` — the single source of truth, intended to graduate to a user setting later. Today's defaults follow a glyph mnemonic: **triangles** for the structural pairs (parent/children for the vertical hierarchy, dependsOn/dependents for the temporal flow with the prerequisite "to the left" of the dependent), **thinner arrows** for the lateral relatedTo/related link, and `warning` on dangling forward edges.

**Canonical-occurrence gating.** Lenses only render on the canonical occurrence of an `@id` (the lex-lowest `(fileUri, line)` in the workspace). Duplicate-`@id` losers get a diagnostic squiggle pointing at the canonical winner instead of a (potentially misleading) lens.

**Duplicate-`@id` warnings.** The graph's `DuplicateIdReport`s flow through `DiagnosticsManager` (`src/diagnostics-manager.ts`), which merges them with the cache's per-file scan warnings before writing to the `DiagnosticCollection`. Every occurrence gets its own diagnostic — one "canonical occurrence" marker, the rest "takes precedence" deferrals. The `tsk` Output channel keeps the full chronological log via the cache's existing dup-id `CacheWarning` (filtered out of the Problems panel to avoid double-display).

**Commands are not contributed to `contributes.commands`** — they're invoked exclusively by lens clicks. No palette entries, no keybindings; the lens IS the invocation. They are registered (`vscode.commands.getCommands` reports them) so other extensions can compose if needed.

**Codelens font caveat.** `editor.codeLensFontFamily` controls the rendered font; in practice it doesn't always match the editor font even when the option doc implies it should. We don't customize per-lens fonts — only the global setting helps.

## Navigation highlight (M10)

Clicking a forward-edge lens (parent / dependsOn / relatedTo) lands on the target file and line, then leaves a soft whole-line tint on that line until the next interaction. Implementation in `src/navigation-highlight.ts`. The highlight is **persistent, not a flash** — no timer, no fade. It clears on:

- another navigate (the next `set()` replaces the prior highlight before applying the new one),
- a user-initiated cursor move (`TextEditorSelectionChangeKind.Keyboard` or `Mouse`) in the highlighted editor,
- the active editor moving off the highlighted one (tab switch, editor close).

Programmatic selection changes (`TextEditorSelectionChangeKind.Command`) are deliberately ignored, otherwise the navigate's own `editor.selection = …` would clear the highlight before the user even saw it.

Theme the tint via `workbench.colorCustomizations` and the `tsk.navigation.highlight` color id — defaults are soft yellow with alpha so it works on both light and dark themes without overwhelming the text underneath.

## Conventions

- Pure logic in `src/lib/**` is unit-tested with vitest; user-visible behavior is e2e-tested with `@vscode/test-cli`. A feature is incomplete without both.
- After every user-visible feature lands, `docs/demo.tsk` is updated to exercise it.
- Detailed scoped rules: see [`CLAUDE.md`](./CLAUDE.md).
