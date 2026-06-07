# tsk

A Markdown-based task manager for VS Code. `tsk` works on `.tsk` files — Markdown task lists enriched with inline metadata, tags, relationship graphs, code lenses, and a queryable cache.

A task is just a Markdown checkbox line; tsk fills in the bookkeeping and layers editing, navigation, and search on top:

```
- [ ] ship the release <!-- @id:a1b2c3 @created:2026-05-30T09:00:00+08:00 -->
- [/] write the changelog #project/tsk <!-- @id:d4e5f6 @parent:a1b2c3 @started:2026-05-30T11:00:00+08:00 -->
```

- **Status markers** — todo / in-progress / done / cancelled / note / moved, each toggled by a keystroke and stamped with a timestamp.
- **Priorities** that tint the whole line; **tags** (`#tag/sub/leaf`) with completion and one-key search.
- **Relationships** (`@parent` / `@dependsOn` / `@relatedTo`) surfaced as clickable code lenses and an on-hover summary.
- **List editing** — Enter / Tab / Shift+Tab / Backspace tuned for nested task lists.
- A **SQLite cache** that powers tag search and the relationship graph across your whole workspace.

Open any `.tsk` file — or the bundled `docs/demo.tsk`, a hands-on tour where every line is live — and the features below light up.

## Status markers & toggles

The commands below operate on the cursor line (or every unique cursor line in a multi-cursor selection). Each builds a single edit, so one `Ctrl+Z` reverts the whole operation.

| Keybinding   | Command                                       | Behavior |
|--------------|-----------------------------------------------|----------|
| `Alt+A`      | `tsk.toggleTodo`                              | Wrap a plain/empty line (or a bare `-` bullet) as `[ ]` with `@id` + `@created`; unwrap an empty todo. |
| `Alt+S`      | `tsk.toggleInprogress`                        | Swap marker to `[/]` + `@started`; toggling again reverts. |
| `Alt+C`      | `tsk.toggleCompleted`                        | `[x]` + `@completed`. |
| `Alt+X`      | `tsk.toggleCancelled`                        | `[!]` + `@cancelled`. |
| `Alt+N`      | `tsk.toggleNote`                             | Wrap a plain line as `[n]`; flip any task to/from `[n]` (reversible). |
| `Alt+M`      | `tsk.toggleMoved`                            | Picker → `[>]` + `@movedTo` + `@moved`. Empty submission writes only `@moved` (moved-elsewhere). Toggling again reverts. |
| `Alt+R / D / P` | `tsk.toggleRelatedTo` / `DependsOn` / `Parent` | Absent → picker → write; present → silently remove. |
| `Alt+1 / 2 / 3` | `tsk.toggleP1` / `P2` / `P3`                | Toggle `@priority:N`; switching levels overwrites in one step. |
| `` Alt+` ``  | `tsk.copyTaskId`                             | Copy the current task's `@id` to the system clipboard. |

The picker-driven commands (move + the relationships) open an input box prefilled with the sanitized first token of clipboard text. Click the **Browse tasks…** button (search icon) to switch to a list of every cached task across the workspace.

**Keybinding caveats:**
- `Alt+1` / `Alt+2` / `Alt+3` are globally bound to "Focus N-th Editor Group" in VS Code defaults. The `when: editorLangId == 'tsk'` clause makes the toggle win inside `.tsk` files; the editor-group focus still works elsewhere.
- `` Alt+` `` uses the backtick key, which varies by keyboard layout — UK / DE / FR users may need to rebind via the Keyboard Shortcuts editor.
- Other `Alt`-letter combos depend on installed extensions and themes; the language-scoped `when` clause prevents `.tsk` toggles from leaking outside, but a third-party extension binding the same chord with an equally specific `when` clause could clash.

## Marker, priority & metadata coloring

Visual layers on `.tsk` documents — most run through VS Code's **semantic tokens** (the same pipeline as syntax highlighting, so they recolor *instantly* with the text), while the priority background stays a decoration:

- **Marker color (semantic token).** Each `[X]` triplet is colored per status — `[ ]` yellow, `[/]` blue, `[x]` green, `[>]` orange, `[!]` gray (struck through), `[n]` purple. Colors ship as defaults under token type `taskMarker` (one modifier per status); recolor any via `editor.semanticTokenColorCustomizations`, e.g. `"taskMarker.completed": "#9ece6a"`. Toggling a status recolors with no delay.
- **Inline metadata dim (semantic token).** Every `<!-- @key:value -->` block is dimmed (token type `taskMetadata`) so the comments recede; the hover popup surfaces the parsed values when you need them. Recolor via `"taskMetadata"` in the same setting.
- **Priority line background (decoration).** `@priority:1` paints the line red, `:2` yellow, `:3` blue. Opacity is settable via `tsk.decorations.priority.opacity` (default `0.15`, range 0–1); applies live. This stays a decoration — only `setDecorations` can paint a whole-line background (a semantic token can't) — so it refreshes on editor focus, after save, and on a short post-change debounce rather than instantly.

On top of these, a task's *text* is ordinary Markdown: `.tsk` extends the Markdown grammar, so inline `code`, **bold**, *italic*, and `[links](…)` render inside task lines exactly as they do elsewhere in the document — while the marker triplet and `<!-- … -->` metadata keep their own coloring. (The grammar wraps each task line so the embedded Markdown engages mid-line, which a flat checkbox match wouldn't.)

The `tsk.marker.*` / `tsk.metadata.foreground` *workbench* colors (override via `workbench.colorCustomizations`) still drive the **Search Editor result rows** from `Alt+T`, which can't carry semantic tokens and are painted as decorations instead.

## List editing

`Enter` / `Tab` / `Shift+Tab` / `Backspace` inside a `.tsk` file are intercepted to mimic [Markdown All in One](https://marketplace.visualstudio.com/items?itemName=yzhang.markdown-all-in-one)'s list semantics, with one tsk-specific twist: inline metadata never gets pushed to the next line.

| Key       | Behavior                                                                                              |
|-----------|-------------------------------------------------------------------------------------------------------|
| `Enter`   | Cursor at end-of-content (before `<!--` or end of line) → continue the list with a fresh empty task (new `@id` + `@created`). Cursor mid-content → split at the cursor; **metadata stays on the original line**. On an empty task → outdent (col > 0) or remove the whole task (col 0). |
| `Tab`     | On an empty task → indent one level (spaces or tab per editor settings). Otherwise → default editor Tab. |
| `Shift+Tab` | On any task with indent → outdent one level. Otherwise → default editor outdent. |
| `Backspace` | On an empty task (cursor in the content area) → degrade to a bare `- ` bullet, dropping the `[m]` marker and all metadata. On an empty `- ` bullet → strip the marker, leaving the indent. Otherwise → default editor delete. |

**Continuation marker is always `[ ]`** — pressing `Enter` at the end of a `[x]` completed task still creates a fresh `[ ]` todo on the next line.

**Bare bullets** — a `-` / `*` / `+` list item *without* a `[ ]` marker (the checkbox-less notes you nest under a task) gets the same `Enter` / `Tab` / `Shift+Tab` treatment as a task, minus the metadata: `Enter` continues the bullet (preserving the original marker char), and the empty-bullet / indent rules match the task paths. `Backspace` closes the loop — `task → bare bullet → (indent →) empty line`, the inverse of `Alt+A`'s `bare bullet → task` wrap.

**Duplicating tasks** — `Shift+Alt+↓` / `Shift+Alt+↑` wrap VS Code's built-in line duplication in `.tsk` files: the copy is stamped with a fresh `@id` + `@created` so it can't collide with its source, while lifecycle stamps (`@started` / `@completed`) are preserved. (Two undo steps by design — the duplicate, then the id rewrite — which also makes multi-cursor duplication work for free.)

Every list-edit keybinding carries `when: editorLangId == 'tsk' && editorTextFocus && !suggestWidgetVisible && !inSnippetMode`, so `Enter` accepts an IntelliSense suggestion when one is visible and `Tab` advances a snippet placeholder when one is active — the list-edit handler stays out of the way.

## Tags & search

Tags use `#tag` and `#tag/sub/leaf` syntax inside `.tsk` files. Two surfaces sit on top:

- **`#`-triggered completion.** Type `#` (or `#partial`) in any `.tsk` editor and a completion list surfaces every known tag. Items merge two sources: tags declared in the workspace `tags.yml` (with descriptions, shown as the item detail) and tags discovered in `.tsk` files via the cache — plus implicit `/`-separated parents, so `#project/tsk` automatically contributes `#project`.
- **`Alt+T` find-all-tasks-by-tag.** Opens a list of every known tag — each row showing a hierarchical task count (`5 tasks · <description>`), searchable by name, count, *and* description — then opens VS Code's **Search Editor** with `#<tag>` pre-queried, scoped to `*.tsk`. You get Ctrl+Click navigation, regex/case toggles, and result folding for free, and the search opens with **0 context lines** so only the matching task rows show. The Search Editor's own grammar can't highlight tsk rows, so the extension paints tsk **decorations** (marker colors, priority backgrounds, dimmed metadata) onto the match rows itself. The per-tag count is prefix-inclusive (a `#project` row counts its `#project/tsk` tasks too), matching what the substring search returns.
- **Find all tasks by status** (Command Palette → *Tsk: Find All Tasks by Status*; palette-only, since `Alt+T` is the tag search). Pick a status marker — each row shows its `[glyph]` and a task count — and it opens the same Search Editor with a line-anchored **regex** (`^\s*[-*+] \[<glyph>\]`) scoped to `*.tsk`, listing every task carrying that marker. The anchor keeps `[ ]` (todo) from matching stray empty brackets in prose; the result rows get the same tsk decorations as the tag search.

**`tags.yml` location.** Default `${workspaceFolder}/.vscode/tsk/tags.yml` (configurable via `tsk.tags.path`). Both schema forms are accepted:

```yml
<tag>: <description>            # string shorthand
<tag>:                          # object form
    description: <description>
    parent: <tag>
```

Empty / missing / malformed `tags.yml` is tolerated — the loader returns an empty map rather than throwing, and re-reads on create/change/delete.

**Search semantics.** The `#tag` query is a literal substring, so `#project` also matches lines containing `#project/tsk` — read this as a feature: parent-tag searches naturally include their children. For exact matches, toggle regex in the Search Editor's toolbar (e.g. `(?<![\w/-])#project(?![\w/-])`).

## Autolinks

Turn text matching a regular expression into a clickable link in `.tsk` editors — `Ctrl`/`Cmd`+Click to open. Rules live in `tsk.autolinks` (an array, empty by default — opt-in):

```jsonc
"tsk.autolinks": [
  { "pattern": "([A-Z]+)-([0-9]+)", "target": "https://jira.example.com/browse/$1-$2" }
]
```

Every line is scanned (not only task lines), so a tagged `#JIRAID-123` and a bare `JIRAID-123` both link. Per rule:

- **`pattern`** — a JavaScript regex; the `g` flag is always applied. Capture groups (including named `(?<name>…)`) feed the template. Optional **`flags`** may add any of `i` `m` `s` `u`.
- **`target`** — a URL template with `String.replace` substitution: `$1`/`$2` (numbered groups), `$<name>` (named), `$&` (whole match), `$$` (a literal `$`).

Earlier rules win where matches overlap. Substitution is **raw** — the captured text drops into the URL as-is, so anchor your pattern to capture exactly what the URL needs. A pattern relying on **look-behind/look-ahead** positions the link correctly but won't substitute (the URL falls back to the raw match, and is skipped when that isn't a valid URI).

## Relationships, code lenses & navigation

Every task with relationship metadata grows code lenses showing forward edges (`parent: <id>` / `dependsOn: <id>` / `relatedTo: <id>` / `movedTo: <id>`) and inverse edges (`children: N` / `dependents: N` / `related: N` / `movedHereFrom: N`). `@movedTo` (a `[>]` task's "moved to" pointer) is a first-class graph edge: it shows the forward `movedTo: <id>` lens, the move target gains an inverse `movedHereFrom: N` lens, and a dangling `@movedTo` squiggles like any other broken reference. Each title is prefixed with a [codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html) hinting the relationship type.

| Lens                       | Command                  | Behavior |
|----------------------------|--------------------------|----------|
| `parent: <id>`             | `tsk.goToParent`         | Open the parent's file at the parent's line. |
| `children: N`              | `tsk.findAllChildren`    | Peek view of every task pointing here via `@parent`. |
| `dependsOn: <id>`          | `tsk.goToDependsOn`      | Open the depended-on task's location. |
| `dependents: N`            | `tsk.findAllDependents`  | Peek view of every task `@dependsOn`-pointing here. |
| `relatedTo: <id>`          | `tsk.goToRelated`        | Open the related task's location. |
| `related: N`               | `tsk.findAllRelated`     | Peek view of every task `@relatedTo`-pointing here. |
| `movedTo: <id>`            | `tsk.goToMovedTo`        | Open the move target's location (a `[>]` task's `@movedTo`). |
| `movedHereFrom: N`         | `tsk.findAllMovedHereFrom` | Peek view of every task that `@movedTo`-points here. |
| `<key>: <id> (missing)`    | `tsk.codelens.missing`   | Info toast — the referenced `@id` isn't in the workspace. |

These commands are invoked exclusively by lens clicks — no palette entries, no keybindings; the lens *is* the invocation.

**Canonical-occurrence gating.** Lenses render only on the canonical occurrence of an `@id` (the lex-lowest `(file, line)` in the workspace). Duplicate-`@id` losers get a diagnostic squiggle pointing at the canonical winner instead of a potentially misleading lens.

**Navigation highlight.** Clicking a forward-edge lens (parent / dependsOn / relatedTo / movedTo) lands on the target line and leaves a soft whole-line tint there until your next interaction. It's persistent, not a flash — it clears on the next navigate, a user-initiated cursor move in that editor, or the active editor moving off it. Theme it via `workbench.colorCustomizations` and the `tsk.navigation.highlight` color id (default: soft yellow with alpha, readable on light and dark themes).

## Now task & tree

`Alt+W` (**Tsk: Mark Now**) marks the task under the cursor as your current "now". In a single undo step it stamps a missing `@id` (+ `@created`) and — unless you turn off `tsk.now.autoInProgress` — flips the marker to `[/]` and stamps `@started`, the same transition the `Alt+S` in-progress toggle applies. The current now-task carries a persistent border around its line (the `tsk.now.highlight` color), a box kept visually distinct from the priority line-background tint.

Marks accumulate into an **undo-tree**, not a stack: each new mark becomes a child of the current one, and switching to an earlier node and marking again *branches* rather than overwriting — history is never pruned implicitly. Open the tree from the `target` button in a `.tsk` editor's title bar, or **Tsk: Open Now Stack**. It's a React webview that docks **beside** the file like a Markdown preview (and pops out via *Move / Copy into a New Window*), rendered with [`@grida/tree-view`](https://grida.co/packages/@grida/tree-view) for a native tree feel — keyboard nav (`↑`/`↓` move, `←`/`→` collapse/expand, `Enter` jumps), twisties, collapse-state that persists.

The tree uses **linear-compaction**: the path from root to the current now renders as a flat trunk (current at the top), and only real branches indent — so a mostly-linear history stays flat instead of deeply nested.

| Action | What it does |
|--------|--------------|
| **Click a node** | Jump to that task. Reuses the editor beside the panel (a task in another file opens in that group — never a stray tab over the panel). Read-only; never edits. |
| **Set as current** | Switch the now-pointer to that node. Undo / redo is a pointer move — nothing is deleted. |
| **Back** (toolbar) | Switch to the current node's parent (undo one step). |
| **Remove** | Drop one node, re-parenting its children onto its parent. |
| **Delete branch** | Drop a node and its whole subtree. |
| **Remove children** | Drop a node's descendants, keeping the node itself. |
| **Prune off-path** (toolbar) | Drop every branch not on the path to the current now (linearize). |
| **Clear** (toolbar, or **Tsk: Clear Now History**) | Wipe the whole tree — confirm via a notification toast (not a blocking modal); your tasks are untouched. |

**Persistence.** The now-tree lives in its own SQLite `state.db` (default `${workspaceFolder}/.vscode/tsk/state.db`, set via `tsk.state.path`) — **separate from `cache.db`**, so **Tsk: Rebuild Cache** leaves it intact. With no workspace folder it's session-only (in-memory). Like the cache, it's single-root today.

**Recurrence.** The same task can appear at several nodes (mark it, move on, come back later) — a node's identity is its position in the tree, not the `@id`, so one task can sit at multiple points in your history.

**Limits (v1).** No in-panel search/filter; a now-task in a *closed* file shows no in-editor highlight (only the tree label); `@movedTo` isn't followed; multi-root workspaces aren't supported yet (same as the cache).

## Stats & task list

Two more React webview panels visualize every task in the workspace, opened from the Command Palette:

- **Tsk: Open Stats** — a GitHub-style **activity calendar** of task events (created / started / completed / cancelled / moved) with a metric toggle, above a row of current-status **count tiles** (todo / in-progress / done / …). It reads the `@created` / `@started` / `@completed` timestamps tsk stamps on each status transition, scales its squares to fit the panel width (so a whole year stays visible in a narrow panel), and tracks your theme. Those stamps are written only when you toggle via the commands — and `@started` / `@completed` clear on toggle-back — so the calendar reflects tasks *currently* bearing each stamp: a best-effort history, not an append-only log.
- **Tsk: Open Task List** — every task as a **status-filtered, click-to-jump list**: filter chips with live counts, a virtualized scroll list (marker `[glyph]` + content + `file:line`), and a row click that reveals the task beside the panel. The persistent, browse-and-stay companion to *Tsk: Find All Tasks by Status* (which stays the fast keyboard path).

Both refresh live as you edit and revive after a window reload. `docs/many-tasks.tsk` is a ready-made backlog for trying them out.

## Hover

Hovering a task surfaces a Markdown popup of its parsed metadata, so you needn't decode the dimmed `<!-- … -->` comment by eye. It lists the `@id`, each timestamp rendered both absolutely and as friendly relative time (`… (3 days ago)`), the tags, and any relationship links — each link a clickable command URI that jumps to the referenced task. The task content itself is deliberately *not* repeated (it's already under your cursor). Document-local, so it works on untitled buffers too.

## Code actions & diagnostics

Two `Ctrl+.` helpers:

- **Add missing id.** A markered task with no `@id` (any marker, not only `[ ]`) offers *"Tsk: Add missing id + created"* (or *"…Add missing id"* when `@created` is already present), writing the same metadata `Alt+A` would. Unlike the `Alt+A` toggle — which fires only on its own target marker — the quick-fix is marker-agnostic, so you can promote a hand-typed `- [x] done` imported from elsewhere.
- **Broken references.** When a task's `@parent` / `@dependsOn` / `@relatedTo` / `@movedTo` points at an `@id` with no canonical occurrence in the workspace, the line gets a `Warning` squiggle. The lightbulb offers *"Tsk: Remove broken @parent"* (or `@movedTo`, etc.) to drop it, or *"Tsk: Replace @parent via picker…"* to pick a real task.

Warnings surface in both the `tsk` Output channel and the Problems panel: today's categories are duplicate `@id` and task-without-`@id`.

## Paste an image

Pasting an image (`Ctrl+V`) into a `.tsk`, Markdown, or Jupyter markdown-cell document saves the bytes to disk and inserts a relative Markdown image link at the cursor, the alt text a snippet placeholder so it lands selected.

- **Where it saves.** `<document directory>/<tsk.pasteImage.baseDirectory>/<name>.<ext>`. The base directory defaults to `./images` (relative to the document; blank ⇒ beside it). The extension comes from the clipboard MIME, not from any typed name (so a JPEG named `diagram` is saved as `diagram.jpg`).
- **Naming.** Select text before pasting and the selection is the path verbatim — it may include subfolders, which are created. With no selection an input box prompts (prefilled with a timestamp). On a collision you're re-prompted, then asked to confirm an overwrite.
- **Undo.** The write rides the paste's edit, so one `Ctrl+Z` removes the link and the saved file together. Caveat: undoing an *overwrite* deletes the file rather than restoring the original ([microsoft/vscode#182573](https://github.com/microsoft/vscode/issues/182573)).

## Clipboard bridge (devcontainers)

Inside a devcontainer, no host clipboard tool is reachable — `xclip` / `wl-copy` / `clip.exe` / `pbcopy` aren't installed or can't see the host, and OSC 52 escape sequences don't always survive. But the **extension host** runs with `vscode.env.clipboard` access. The clipboard bridge exploits that: it watches a file and copies the file's contents to the host clipboard on every change, so any process that can write a file (a shell, an agent) can push text to the host clipboard.

It's **opt-in** — both settings default to off / unset:

| Setting | Default | Meaning |
|---|---|---|
| `tsk.clipboard.bridgeEnabled` | `false` | Master switch. Silently watching a file and pushing it to the clipboard is surprising to enable by default. |
| `tsk.clipboard.bridgePath` | `${workspaceFolder}/.vscode/tsk/clipboard-bridge.txt` | The watched file. `${workspaceFolder}` is expanded at runtime; an absolute path is used verbatim. Blank / no workspace folder ⇒ bridge inactive. |

Enable it, then `echo "hello" > .vscode/tsk/clipboard-bridge.txt` and `"hello"` lands on your host clipboard. The bridge uses stat-polling (re-stats the path every ~300 ms) rather than `fs.watch`, because the editor's atomic save swaps the file's inode — an inode-bound watch goes silent after the first save, and inotify is unreliable on devcontainer / WSL2 mounts anyway. The trade-off is up to ~300 ms of latency, imperceptible for paste-after-write.

The command **Tsk: Install Clipboard Bridge Skill** writes a ready-made [Claude Code](https://claude.com/claude-code) skill into `.claude/skills/` in your workspace, with your configured bridge path baked in, so you can ask the agent to "put X on my clipboard" and it writes the watch file for you.

## The cache

On activation, tsk scans `**/*.tsk` (excluding `**/node_modules/**`) and indexes tasks into a SQLite cache that powers tag search and the relationship graph:

- Default location `${workspaceFolder}/.vscode/tsk/cache.db`, configurable via `tsk.cache.path`. Falls back to in-memory when no workspace folder is open.
- File events (watcher, save, debounced edit) trigger per-file rescans; reopening preserves data.
- Run **Tsk: Rebuild Cache** to purge and rerun the initial scan if anything looks stale.

## Settings

Every user-facing setting lives in `package.json#contributes.configuration`; the defaults below are the manifest's.

| Setting | Default | Description |
|---------|---------|-------------|
| `tsk.cache.path` | `${workspaceFolder}/.vscode/tsk/cache.db` | On-disk SQLite cache (`${workspaceFolder}` expanded at runtime; in-memory when no workspace folder is open). |
| `tsk.tags.path` | `${workspaceFolder}/.vscode/tsk/tags.yml` | Workspace `tags.yml` for tag descriptions + completion. Blank ⇒ no file loaded (tags discovered in `.tsk` files still complete). |
| `tsk.log.level` | `info` | `tsk` Output-channel verbosity: `debug` / `info` / `warn` / `error`. |
| `tsk.editor.changeDebounceMs` | `300` | Debounce (ms) before re-applying priority decorations / rescanning a `.tsk` document after a text change (range 0–5000). Marker + metadata colors are semantic tokens and update independently of this. |
| `tsk.decorations.priority.opacity` | `0.15` | Background opacity (0–1) of priority line tints; applies live. |
| `tsk.clipboard.bridgeEnabled` | `false` | Master switch for the clipboard bridge (watch a file → host clipboard). |
| `tsk.clipboard.bridgePath` | `${workspaceFolder}/.vscode/tsk/clipboard-bridge.txt` | The watched bridge file; only used when the bridge is enabled. |
| `tsk.pasteImage.baseDirectory` | `./images` | Base directory (under the document) for pasted images. Blank ⇒ beside the document. |
| `tsk.state.path` | `${workspaceFolder}/.vscode/tsk/state.db` | On-disk SQLite store for the now-tree, separate from the cache (survives **Rebuild Cache**). In-memory when no workspace folder is open. |
| `tsk.now.autoInProgress` | `true` | When marking a task as "now" (`Alt+W`), also flip its marker to `[/]` and stamp `@started` (like `Alt+S`). Turn off to leave the marker unchanged. |
| `tsk.autolinks` | `[]` | Regex→URL rules; text matching a rule becomes a `Ctrl`/`Cmd`+clickable link in `.tsk` editors. See *Autolinks*. |

Themable colors are also contributed (override via `workbench.colorCustomizations`): `tsk.marker.{todo,inprogress,completed,moved,cancelled,notes}`, `tsk.metadata.foreground`, `tsk.navigation.highlight`, `tsk.now.highlight`. The marker and metadata colors drive the **Search Editor result rows** (which can't carry semantic tokens); `tsk.navigation.highlight` and `tsk.now.highlight` are in-editor line decorations (the navigate-flash and the now-task border). In `.tsk` editors, markers and metadata recolor via `editor.semanticTokenColorCustomizations` instead (see *Marker, priority & metadata coloring*).

## Limitations

### Untitled buffers

Open a new buffer (`Ctrl+N`), set the language to `tsk`, and these work locally — they're document-local and don't need the cache:

- Marker + metadata **semantic-token coloring** and priority **decorations**
- **Toggle commands** and **list-edit** semantics (`Enter` / `Tab` / `Shift+Tab` / `Backspace`)
- **Tag completion** (`#`) — surfaces workspace-known tags
- The **Add missing id** code action
- **Hover** and **diagnostics**

These do **not** work on untitled buffers, because they require the file-only SQLite cache:

- **Code lenses** — neither forward nor inverse lenses render on untitled tasks (the lens needs the source task in the graph, and untitled tasks are excluded from the cache).
- **Find by Tag** results — the Search Editor only scans on-disk `*.tsk` files.

Save the buffer to disk to opt back into the cache-backed features.

## Requirements

Requires **VS Code 1.112+** (the extension declares `engines.vscode = "^1.112.0"`). The Marketplace gates installs against this, so older hosts won't be offered the extension. The floor is kept deliberately wide for Cursor / VSCodium / Insiders reach.

## Development

```sh
npm install            # one-time
npm run build          # host (dist/host/extension.cjs) + webview (dist/webview/now-stack.js)
npm run build:host     # just the extension host bundle (Vite library mode, CJS)
npm run dev:host       # host bundle, watch mode (dev:webview watches the webview)
```

Open the repo in VS Code and pick **Run and Debug → Run Extension** to launch a development host with the extension loaded. After a fresh `npm run build:host`, the running dev host still has the *previous* bundle — run **Developer: Restart Extension Host** in the dev host window to pick up the new build.

### Tests

```sh
npm test               # vitest unit tests (src/**/*.test.ts)
npm run test -- --coverage   # with v8 coverage; fails under 80% on src/lib/**
npm run test:e2e       # @vscode/test-cli — runs against `stable` VS Code (latest)
npm run test:e2e:floor # @vscode/test-cli — runs against the engine floor (1.112)
npm run test:e2e:all   # both labels in sequence
```

`.vscode-test.mjs` defines two labeled configurations:

- **`stable`** — downloads the latest VS Code at run time. Catches the "newest still works" signal.
- **`floor`** — pinned to VS Code `1.112.0`, the engine floor. Catches the "minimum supported still works" signal. Together with a strict-subset `@types/vscode@~1.110` typecheck (1.110 is the closest published type package at or below the floor; anything that typechecks against that subset is guaranteed to run on 1.112+), this is the second of two layers holding the codebase to the floor. The floor config carries a more generous mocha timeout (60s) — extension-host startup and config-change propagation are slower on the 1.112 host in a devcontainer.

The e2e runner auto-wraps in `xvfb-run` when available (devcontainer/CI) and otherwise relies on a real display. The coverage gate is opt-in (instrumentation slows iteration) — bare `npm test` skips it.

### Adding an e2e test

End-to-end tests live in `tests/e2e/**/*.test.ts` and run inside a real VS Code host. The pattern is mature enough that adding one usually means picking a recipe below.

Acquire the extension API:

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

`TskExtensionApi` carries test-only introspection methods (`counts()`, `findTaskById(id)`, `getDecorations(uri)`, `getTags()`, `reloadTags()`, `lookupGraph(id)`, `getNavigationHighlight()`, …) that delegate to live activation-layer state, so assertions read the same values the extension renders.

Workspace fixtures live in `tests/e2e/fixtures/workspace/` — the host opens this folder as its root, so cache + graph + tag scans see every `.tsk` file there. Adding a `.tsk` fixture changes the cache counts, so update the `cache.test.ts` `counts.*` assertions in lockstep.

**Robust assertion patterns:**
- **Provider outputs** via the built-in `vscode.execute…` commands (`executeCodeLensProvider`, `executeCompletionItemProvider`, …).
- **Command registration** via `vscode.commands.getCommands(true)`.
- **Keybinding / configuration drift** via `ext.packageJSON.contributes.keybindings` / `.configuration.properties`.
- **Document edits** via `editor.selection = …` + `executeCommand('tsk.foo')` + reading `doc.getText()` back. Yield with `await new Promise(r => setImmediate(r))` between an action and its assertion.

**Don't try to assert** the visual rendering of decorations (assert the `api.getDecorations(uri)` snapshot instead), QuickPick contents at the UI level, info/warning toasts (test the precondition), or true user-input kinds — `editor.selection = …` and `executeCommand` always fire `TextEditorSelectionChangeKind.Command`, so factor input-kind-dependent logic into a pure helper and unit-test it.

### Lint, format & package

```sh
npm run lint           # biome check .
npm run format         # biome format --write .
npm run package        # builds, then @vscode/vsce → tsk-<version>.vsix
```

### Architecture

Pure, vscode-free logic lives in `src/lib/**` and is unit-tested with vitest (parser, metadata serializer, marker/priority registries, graph builder, cache helpers, list-edit and toggle logic, …). The thin glue that touches the VS Code API lives in `src/*` next to `extension.ts` and is exercised by the e2e suites. Markers and priorities are driven by single-source registries (`src/lib/markers.ts`, `src/lib/priorities.ts`) mirrored into `package.json` and the grammar, with a drift test keeping them in sync — adding a marker is a registry entry plus the mirror.

### Conventions

- Pure logic in `src/lib/**` is unit-tested (vitest); user-visible behavior is e2e-tested (`@vscode/test-cli`). A feature is incomplete without both.
- After every user-visible feature lands, `docs/demo.tsk` is updated to exercise it.
- Detailed scoped rules: see [`CLAUDE.md`](./CLAUDE.md).

### Contributing

This extension is developed inside a larger private monorepo and published here as a standalone repository, mirrored with `git subtree split` (fast-forward only, never force-pushed). Please file **issues** on this repo. **Pull requests** are welcome too, but because the monorepo is authoritative, an accepted PR is applied upstream via cherry-pick (you keep authorship) and lands here on the next sync — so your PR may be closed with an "applied as `<sha>`" note rather than merged directly. For a small fix, an issue with a diff is the quickest path.
