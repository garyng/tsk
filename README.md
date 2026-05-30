# tsk

A markdown-based task manager VSCode extension. Works on `.tsk` files, enriching markdown task lists with inline metadata, tags, relationship graphs, code lenses, and a queryable cache.

**Status — Phases 1–3 substantially complete.** Phase 1 (M0–M12) brought activation, the TextMate grammar, the SQLite cache with scan-time diagnostics, marker/priority/metadata decorations, the toggle + list-edit command set, tag autocompletion and find-by-tag, and the relationship code-lens graph. Phase 2 (M13–M16) was a structural refactor — the `lib/` pure-core split, the constants registry, and the package.json drift tests. Phase 3 (M17–M25) adds untitled-buffer support, add-missing-id code actions, a metadata hover, broken-reference diagnostics with quick-fixes, richer tag search, the clipboard bridge for devcontainers, and the paste-image helper; the remaining tail is this docs overhaul and a public-repo sync skill. (Design plans and full history live in the source monorepo — see [Public sync](#public-sync).)

## Public sync

This extension is developed inside a larger private monorepo and published to **[github.com/garyng/tsk](https://github.com/garyng/tsk)** as a standalone repository — the extension's full history, re-rooted at this directory, mirrored with `git subtree split` (fast-forward only, never force-pushed). The **monorepo is the source of truth**; the public repo is a downstream mirror. Design plans and the broader project history live in the monorepo and aren't part of the mirror.

**Contributing.** Please file **issues** on the public repo. **Pull requests** are welcome there too, but because the monorepo is authoritative, an accepted PR is applied upstream via cherry-pick (you keep authorship) and lands here on the next sync — so your PR may be closed with an "applied as `<sha>`" note rather than merged directly. For a small fix, an issue with a diff is the quickest path.

## Supported VS Code versions

The engine floor is **VS Code 1.112** (`package.json#engines.vscode = "^1.112.0"`) — this widens Cursor / VSCodium / Insiders reach without forcing users onto the newest editor. The Marketplace gates installs against the engines field; older hosts won't be offered the extension.

`@types/vscode` is pinned to **`~1.110.0`** for development (1.110 is the closest published version at or below the 1.112 floor — npm's type package skips 1.111–1.114). Typechecking against the 1.110 surface gives a *subset* of the 1.112 API, so anything that typechecks is guaranteed to run on 1.112+. End-to-end tests run against both a `stable` VS Code download and the `1.112` floor (see "Tests" below) to catch any divergence between the typing's-subset view and the real 1.112 runtime.

## Limitations

### Untitled buffers (M18)

Open a new buffer (Ctrl+N), set the language to `tsk`, and the following work locally:

- Marker / priority / metadata **decorations**
- **Toggle commands** (Alt+A / N / S / C / X / 1 / 2 / 3 / `, M / R / D / P)
- **Tag completion** (`#`) — surfaces workspace-known tags
- **Code action** "Tsk: Add missing id + created"
- **Enter / Tab / Shift+Tab** list-edit semantics
- **Hover** and **diagnostics** — document-local, so they work without the cache

These do NOT work on untitled buffers (they require the SQLite cache, which is file-only):

- **Codelens** — neither forward (`goToParent` etc.) nor inverse (`findAllChildren` etc.) lenses render on untitled tasks. The lens computer's canonical-occurrence gate requires the source task to be in the graph, and untitled tasks are excluded from the cache.
- **Find by Tag** results — the search editor only scans on-disk `*.tsk` files.

Save the buffer to disk to opt back into the cache-backed features. The boundary is enforced by `isPersistableDocument(doc)` in `src/editor-guards.ts` — search there if you're refactoring the cache write paths.

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
npm run test:e2e       # @vscode/test-cli — runs against `stable` VSCode (latest)
npm run test:e2e:floor # @vscode/test-cli — runs against the engine floor (1.112)
npm run test:e2e:all   # both labels in sequence
```

`.vscode-test.mjs` defines two labeled configurations:

- **`stable`** — downloads whatever the latest VS Code release is at run time. Catches the "newest still works" signal.
- **`floor`** — pinned to VS Code `1.112.0` (the engine floor). Catches the "minimum supported still works" signal. Together with the strict-subset `@types/vscode@~1.110` typecheck, this is the second of two layers that hold us to the floor. The floor config carries a more generous mocha timeout (60s) — extension-host startup and config-change propagation are measurably slower on the 1.112 host in our devcontainer.

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
  constants.ts                # cross-cutting constants — language id, settings, theme color ids, COMMANDS / INTERNAL_COMMANDS, defaults
  editor-guards.ts            # requireTskEditor (fetch + validate + log) + isTskDocument (predicate)
  range-helpers.ts            # pointRange — single-line anchor at column 0
  toggle-commands.ts          # applyEdit + registerToggleCommands / registerCopyTaskIdCommand / registerRelationshipCommands
  list-edit-commands.ts       # registerListEditCommands — Enter / Tab / Shift+Tab handlers + default fallback
  picker.ts                   # pickTaskId — InputBox prefilled from clipboard, "Browse tasks…" QuickPick
  tags-loader.ts              # createTagsLoader — reads tags.yml, wires FileSystemWatcher + config listener
  tags-completion.ts          # registerTagsCompletionProvider — #-triggered CompletionItemProvider
  find-tasks-by-tag.ts        # registerFindAllTasksByTagCommand — QuickPick (task counts) → search.action.openNewEditor
  codelens.ts                 # registerCodelens — TskCodeLensProvider + 7 navigate/peek/missing commands
  navigation-highlight.ts     # NavigationHighlight — persistent line decoration after a goTo* navigate
  diagnostics-manager.ts      # DiagnosticsManager — merges scan warnings + graph dup + broken-ref reports per-file
  hover.ts                    # registerHoverProvider — task metadata popup (wraps lib/hover-logic)
  code-actions.ts             # registerCodeActionsProvider — add-missing-id + broken-ref Remove/Replace quick-fixes
  clipboard-bridge.ts         # registerClipboardBridge — fs.watchFile → host clipboard (devcontainer escape hatch)
  install-clipboard-bridge-skill.ts  # tsk.installClipboardBridgeSkill — writes the bridge skill into .claude/skills/
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
    tags-config.ts            # TagDef, parseTagsYaml (named per-rule helpers), expandImplicitParents, mergeTagDefs
    tags-path.ts              # resolveTagsPath — ${workspaceFolder} substitution for tsk.tags.path
    tags-completion-logic.ts  # findTagPrefixContext + buildTagFilterText — pure #-trigger helpers
    tags-find-logic.ts        # tagsToPickItems, countTasksByTag, buildSearchEditorArgs
    hover-logic.ts            # buildTaskHoverMarkdown — pure hover markdown builder (date-fns relative time)
    clipboard-bridge-path.ts  # resolveBridgePath — ${workspaceFolder} substitution for the bridge watch file
    clipboard-bridge-skill.ts # buildClipboardBridgeSkillContent + bridgeDisplayPath — pure skill generator
    graph.ts                  # buildGraph, GraphNode, DuplicateIdReport — pure relationship graph + dup detection
    graph-service.ts          # GraphService — scoped invalidation over the pure builder + occurrences index
    codelens-logic.ts         # computeLensesForTask + CODICONS + LensDescriptor (discriminated union)
    debounce.ts               # scheduleDebounced — keyed setTimeout coalescer, unit-testable with fake timers
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
- **`Alt+T` find-all-tasks-by-tag.** Opens a `QuickPick` of every known tag — each row showing a hierarchical task count (`5 tasks · <description>`), searchable by name, count, *and* yaml description via `matchOnDescription: true` — then dispatches `search.action.openNewEditor` (VSCode's **Search Editor**) with `#<tag>` pre-queried and the include glob scoped to `*.tsk`. The Search Editor is a full result tab: `.tsk` rows keep their grammar highlighting, and Ctrl+Click navigation, regex/case toggles, and result folding come for free — no custom result document needed. The per-tag count is prefix-inclusive (a `#project` row counts its `#project/tsk` tasks too) so it matches what the substring search returns.

**`tags.yml` location.** Default `${workspaceFolder}/.vscode/tsk/tags.yml` (configurable via `tsk.tags.path`). Both schema forms are accepted:

```yml
<tag>: <description>            # string shorthand
<tag>:                           # object form
    description: <description>
    parent: <tag>
```

Empty / missing / malformed `tags.yml` is tolerated — the loader returns an empty map rather than throwing, and a `FileSystemWatcher` re-reads on create/change/delete. A "warn if file exists but parses to empty" log surfaces gross errors in the Output channel.

**Search Editor semantics.** The `#tag` query is a literal substring (`isRegexp: false`), so `#project` will also match lines containing `#project/tsk`. Read this as a feature — parent-tag searches naturally include their children, mirroring the picker's hierarchical count. For exact matches, toggle regex in the Search Editor's toolbar (e.g. `(?<![\w/-])#project(?![\w/-])`).

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

## Hover (M20)

Hovering a task surfaces a Markdown popup of its parsed metadata, so you needn't decode the dimmed `<!-- … -->` comment by eye. It lists the `@id`, each timestamp rendered both absolutely and as friendly relative time (`… (3 days ago)`, via `date-fns/formatDistance`), the tags, and any relationship links — each link is a clickable command URI that jumps to the referenced task. The task content itself is deliberately *not* repeated (it's already under your cursor). Implementation: `src/hover.ts` registers the provider; the markdown is the pure, unit-tested `src/lib/hover-logic.ts`. Document-local, so it works on untitled buffers.

## Code actions & broken-reference diagnostics (M19–M20)

Two `Ctrl+.` helpers, both in `src/code-actions.ts`:

- **Add missing id (M19).** A markered task with no `@id` (any marker, not only `[ ]`) offers *"Tsk: Add missing id + created"* (or *"…Add missing id"* when `@created` is already present), writing the same metadata `Alt+A` would. Unlike the `Alt+A` / `Alt+N` toggles — which only fire on their own target marker — the quick-fix is marker-agnostic, so you can promote a hand-typed `- [x] done` imported from elsewhere.
- **Broken references (M20).** When a task's `@parent` / `@dependsOn` / `@relatedTo` points at an `@id` with no canonical occurrence in the workspace, the line gets a `Warning` squiggle (the same broken-forward-edge the code lens flags with `(missing)`). The lightbulb offers *"Tsk: Remove broken @parent"* to drop it, or *"Tsk: Replace @parent via picker…"* to pick a real task. The backing command `tsk.replaceBrokenReference` lives in `INTERNAL_COMMANDS` — it takes `(uri, line, key)` args only a code action can supply, so it stays out of the palette.

## Clipboard bridge (devcontainer) (M22)

Inside a devcontainer, no host clipboard tool is reachable — `xclip` / `wl-copy` / `clip.exe` / `pbcopy` aren't installed or can't see the host, OSC 52 escape sequences don't survive Claude Code's TUI, and the bundled `code` remote-CLI has no clipboard subcommand. But the **extension host** runs with `vscode.env.clipboard` access. The clipboard bridge exploits that: it watches a file and copies the file's contents to the host clipboard on every change, so any process that can write a file (a shell, a Claude Code skill) can push text to the host clipboard.

**Opt-in.** Both settings default to off / unset:

| Setting | Default | Meaning |
|---|---|---|
| `tsk.clipboard.bridgeEnabled` | `false` | Master switch. Silently watching a file and pushing it to the clipboard is surprising to enable by default. |
| `tsk.clipboard.bridgePath` | `${workspaceFolder}/.vscode/tsk/clipboard-bridge.txt` | The watched file (under `.vscode/tsk/` with `cache.db` + `tags.yml`). `${workspaceFolder}` is expanded at runtime; an absolute path is used verbatim. Blank / no-workspace-folder ⇒ bridge inactive. The parent dir is created if missing. |

Enable it, then `echo "hello" > .vscode/tsk/clipboard-bridge.txt` — `"hello"` lands on your host clipboard. Implementation in `src/clipboard-bridge.ts` (stat-polling watcher); path resolution is the pure, unit-tested `src/lib/clipboard-bridge-path.ts`.

**Why stat-polling, not `fs.watch`.** The bridge uses `fs.watchFile` (re-stats the path every 300 ms) rather than `fs.watch` (inotify). VS Code's own editor save writes a temp file and renames it over the target, which **swaps the inode** — an inode-bound `fs.watch` follows the old inode and goes silent after the first save. Stat-polling follows the rename, and also works on devcontainer / WSL2 mounts where inotify is unreliable. The trade-off is up to ~300 ms of latency before the clipboard updates (imperceptible for paste-after-write). So any writer works: `echo >`, the editor's Save, the `git-commit-phase` skill's `Write`.

**`git-commit-phase` integration.** When the bridge is enabled, the `git-commit-phase` skill's manual mode drops the generated commit message to the watch file (in addition to printing it in chat), so the message is on your clipboard ready to paste into the SCM input — no manual select-and-copy. If the watch file doesn't exist (bridge disabled) the skill skips the drop silently and the chat block remains the copy source.

**Teaching Claude to use it — `Tsk: Install Clipboard Bridge Skill`.** A watched file has no self-describing schema the way an MCP tool does, so Claude has to be *told* the path and the write-the-file protocol. The command palette entry **Tsk: Install Clipboard Bridge Skill** writes a ready-made skill to `.claude/skills/tsk-clipboard-bridge/SKILL.md` in your workspace (Claude Code's per-workspace skill directory), with *your* configured `tsk.clipboard.bridgePath` baked into the instructions. Run it, reload Claude Code, and you can ask Claude to "put X on my clipboard" — it writes the watch file and the bridge does the rest. Re-run it after changing the path setting to regenerate the skill. Implementation: command in `src/install-clipboard-bridge-skill.ts`; the skill body + path-display logic are the pure, unit-tested `src/lib/clipboard-bridge-skill.ts`.

> **Path vs MCP — why a watched file here.** Clipboard hand-off is a single, fire-and-forget side effect with no return value, so the watch-file pattern (Claude already has a `Write` tool; no server, no client config, no transport to reach into the devcontainer) is the right weight. An MCP server earns its keep when Claude needs *structured, bidirectional* access — typed params and **return values** (read the clipboard back, query the cache, list tasks by tag, resolve the graph) — and benefits from schema-driven discovery across a growing set of verbs. Rule of thumb: **need a result back, or many verbs → MCP; fire one side effect → a watched file + a skill that documents the contract.**

## Paste image (M23)

Pasting an image (`Ctrl+V`) into a `.tsk`, Markdown, or Jupyter markdown-cell document saves the bytes to disk and inserts a relative Markdown image link at the cursor, the alt text a snippet placeholder so it lands selected. Implementation: `src/paste-image.ts` registers a `DocumentPasteEditProvider` for the image MIME types; the pure path/snippet logic is the unit-tested `src/lib/paste-image-logic.ts`.

- **Where it saves.** `<document directory>/<tsk.pasteImage.baseDirectory>/<name>.<ext>`. The base directory defaults to `./images` (relative to the document; blank ⇒ beside it). The extension comes from the clipboard MIME, not from any typed name (so a JPEG named `diagram` is saved as `diagram.jpg`, never `diagram.png`).
- **Naming.** Select text before pasting and the selection is the path verbatim — it may include subfolders, which are created. With no selection an input box prompts (prefilled with a timestamp). On a collision you're re-prompted, then asked to confirm an overwrite.
- **Undo.** The write rides the paste's `additionalEdit` (`WorkspaceEdit.createFile`), so one `Ctrl+Z` removes the link and the saved file together. Caveat: undoing an *overwrite* deletes the file rather than restoring the original — `createFile`'s undo is a plain delete, and the delete-then-create workaround throws because VSCode replays an undo's file ops in collection order ([microsoft/vscode#182573](https://github.com/microsoft/vscode/issues/182573)).
- **Paths** use [`pathe`](https://github.com/unjs/pathe) so the Markdown link is forward-slashed on every platform.

## Settings reference

Every user-facing setting (`package.json#contributes.configuration`). Defaults live in the manifest only — see the Constants section for why the code keeps no mirror.

| Setting | Default | Description |
|---------|---------|-------------|
| `tsk.cache.path` | `${workspaceFolder}/.vscode/tsk/cache.db` | On-disk SQLite cache (`${workspaceFolder}` expanded at runtime; in-memory when no workspace folder is open). |
| `tsk.tags.path` | `${workspaceFolder}/.vscode/tsk/tags.yml` | Workspace `tags.yml` for tag descriptions + completion. Blank ⇒ no file loaded (tags discovered in `.tsk` files still complete). |
| `tsk.log.level` | `info` | `tsk` Output-channel verbosity: `debug` / `info` / `warn` / `error`. |
| `tsk.decorations.priority.opacity` | `0.15` | Background opacity (0–1) of priority line tints; applies live. |
| `tsk.clipboard.bridgeEnabled` | `false` | Master switch for the clipboard bridge (watch a file → host clipboard). |
| `tsk.clipboard.bridgePath` | `${workspaceFolder}/.vscode/tsk/clipboard-bridge.txt` | The watched bridge file; only used when the bridge is enabled. |
| `tsk.pasteImage.baseDirectory` | `./images` | Base directory (under the document) for pasted images. Blank ⇒ beside the document. |

Themable colors are also contributed (override via `workbench.colorCustomizations`): `tsk.marker.{inprogress,completed,moved,cancelled,notes}`, `tsk.metadata.foreground`, `tsk.navigation.highlight`.

## Constants & helpers (Phase 2)

Cross-cutting strings, defaults, and small glue helpers live in dedicated modules so a future rename touches one file.

**`src/constants.ts`** is the registry for values that span more than one module:

- **Identifiers** — `TSK_LANGUAGE_ID`, `OUTPUT_CHANNEL_NAME`, `DIAGNOSTIC_SOURCE`. All happen to be the literal `'tsk'` today but stay as separate names; future renames of any one don't drag the others.
- **Settings** — each setting has *two* constants kept side-by-side: `*_SETTING` is the full dotted name (`tsk.cache.path`, used with `affectsConfiguration` and matched against `package.json#contributes.configuration.properties`) and `*_KEY` is the sub-key (`cache.path`, used with `getConfiguration('tsk').get`).
- **Theme color ids** — `METADATA_FOREGROUND_COLOR_ID`, `NAVIGATION_HIGHLIGHT_COLOR_ID`. The marker color ids (`tsk.marker.X`) stay in `lib/markers.ts` because they're registry-internal — properties of the MARKERS definitions, not free-standing constants.
- **Defaults live only in `package.json`** — there are deliberately *no* `DEFAULT_*` setting constants. Each `tsk.*` setting declares its `default` once in `package.json#contributes.configuration`, and code reads it with `getConfiguration('tsk').get(key, <throwaway>)`; VSCode returns the manifest default for a contributed setting, so the fallback argument is dead code (it only degrades sanely were the manifest entry ever missing). One source of truth, nothing to drift. (`readLogLevel` additionally recovers a malformed hand-edited value to `'info'` — a distinct concern from a default.)
- **Timing** — `DOC_CHANGE_DEBOUNCE_MS`, `CLIPBOARD_BRIDGE_POLL_INTERVAL_MS`. Tunable timing values; the former is marked `// TODO: configurable` for a future user setting.
- **Commands** — `COMMANDS` (19 entries, palette-contributed) and `INTERNAL_COMMANDS` (8 entries, lens-/code-action-only). The split keeps `constants.test.ts`'s cross-check against `package.json` sharp: every `COMMANDS` value must appear in the manifest, no `INTERNAL_COMMANDS` value may.

The `// TODO: configurable` marker is the convention for entries that are plausible future user settings. When a setting lands, the constant here becomes the *default* and the lookup site reads `getConfiguration('tsk').get(..., DEFAULT)` instead.

What deliberately doesn't live in `constants.ts`:

- `CODICONS` in `lib/codelens-logic.ts` — registry-internal, tightly coupled to lens construction.
- Regex patterns — co-located with their parser in `parser.ts` / `decorations.ts`.
- The SQL schema — already a `SCHEMA` const in `lib/db.ts`.
- Feature-local consts (e.g. `TRIGGER_CHARACTER = '#'` in `tags-completion.ts`) — single-consumer, not cross-cutting.

**Glue-tier helpers** (sibling to `extension.ts`):

- `editor-guards.ts` — `requireTskEditor(logger, commandId)` fetches `vscode.window.activeTextEditor`, validates the language, logs on miss; `isTskDocument(doc)` is the underlying predicate (also usable from doc-event handlers that have no editor).
- `range-helpers.ts` — `pointRange(line)` returns a zero-width `vscode.Range` at column 0. Used by CodeLens anchors, whole-line decorations, `revealRange` targets.

**Lib-tier helpers**:

- `lib/debounce.ts` — `scheduleDebounced(map, key, ms, fn)`. Pure with respect to its inputs (no module state, no vscode dependency); the shared `map` lets each call site keep its own debounce channel independent.

## Design log

The per-phase decision records — non-obvious choices, trade-offs, "this surprised me" observations — live in `plans/<yyyy-mm-dd>_*.md`. Each completed phase has a **Design notes worth a second look** sub-section capturing the durable rationale that the diff alone doesn't show. Worth grepping before making a similar change.

## Conventions

- Pure logic in `src/lib/**` is unit-tested with vitest; user-visible behavior is e2e-tested with `@vscode/test-cli`. A feature is incomplete without both.
- After every user-visible feature lands, `docs/demo.tsk` is updated to exercise it.
- Detailed scoped rules: see [`CLAUDE.md`](./CLAUDE.md).
