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
| `Alt+R / D / P` | `tsk.toggleRelatedTo` / `DependsOn` / `Parent` | Absent → picker → write; present → silently remove. `@dependsOn` holds a comma list (`@dependsOn:a,b`), so on a task that already has one `Alt+D` opens a menu instead: add another, remove one, or remove all. |
| `Alt+1 / 2 / 3` | `tsk.toggleP1` / `P2` / `P3`                | Toggle `@priority:N`; switching levels overwrites in one step. |
| `` Alt+` ``  | `tsk.copyTaskId`                             | Copy the current task's `@id` to the system clipboard. |

The picker-driven commands (move + the relationships) open an input box prefilled with the sanitized first token of clipboard text. Click the **Browse tasks…** button (search icon) to switch to a list of every cached task across the workspace.

**Keybinding caveats:**
- `Alt+1` / `Alt+2` / `Alt+3` are bound by default (Windows/Linux) to "Open Editor at Index N" — switch to the N-th tab. The `when: editorLangId == 'tsk'` clause makes the toggle win inside `.tsk` files; the editor-group focus still works elsewhere.
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

**Selecting & copying a whole block** — a few gestures grab a task *and its indented sub-block* as a unit. **Double-click** a task's marker, bullet, or indentation to select the whole block — while double-clicking the task's *text* still selects a single word (the marker is the "handle", much like double-clicking a `{` vs. a word in code); turn this off with `tsk.doubleClickSelectsBlock`. With **nothing selected**, `Ctrl+C` / `Ctrl+X` on a task line copy / cut the whole block instead of just the one line VS Code's "copy line" would take — cut removes it cleanly (no orphaned blank line), copy leaves it selected, and block copy / cut / select all include the trailing line break — so a block pastes as its own line (toggle with `tsk.blockTrailingNewline`); any existing selection falls straight through to the native copy/cut. And **Tsk: Select Task Block** (Command Palette, bindable to a key of your choice) is the no-mouse equivalent. All scoped to `.tsk` editors, and the block is whatever the cursor's task owns by indentation — the same range Move/Extract relocate.

**Moving a task to another file** — **Tsk: Move Task to File…** (Command Palette, or a `Ctrl+.` → *Move task to file…* refactor on any task carrying an `@id`) relocates the task *and its indented sub-block* to a `.tsk` file you pick — or a new one via a save dialog — appending it there. The relocated task **keeps its `@id`**, so every `@parent` / `@dependsOn` / … reference still resolves at the new location (id→location lookup is file-independent), while a `[>]` breadcrumb stays behind with a *fresh* `@id` + `@movedTo:<original>` — reusing the moved-marker lens, so you can click straight to where the task went. It's one atomic edit (single undo). Tasks with no `@id` are rejected (add one first); inline `#tags` are stripped from the breadcrumb so a tag isn't double-counted.

**Extracting** — **Tsk: Extract Task to File…** (or `Ctrl+.` → *Extract task to file…*) is the breadcrumb-less twin: the same relocation (the block, the `@id`, markdown child-conversion, atomic undo, new-file-via-save-dialog), but the original is **deleted outright** — no `[>]` stub stays behind. Reach for it when you're reorganizing where work lives and don't want a forwarding pointer; use *Move* when you do.

Every list-edit keybinding carries `when: editorLangId == 'tsk' && editorTextFocus && !suggestWidgetVisible && !inSnippetMode`, so `Enter` accepts an IntelliSense suggestion when one is visible and `Tab` advances a snippet placeholder when one is active — the list-edit handler stays out of the way.

## Tag definitions

**Ctrl+click a `#tag`** to jump to its entry in `tags.yml`. That's Go-to-Definition, so `F12`, `Alt+F12` (peek) and the context menu all work too.

A tag that isn't declared there resolves to nothing, and VS Code says "no definition found" — a truthful answer rather than silence. `Ctrl+.` on it then offers **Define #tag in tags.yml…**, which prompts for a description and appends `tag: "description"`, creating the file if needed. **Tsk: Define Tag in tags.yml…** is the palette equivalent for the tag under the cursor, and on an already-declared tag it just opens `tags.yml` at that entry.

Descriptions are always written double-quoted. A tag *name* is safe as a bare YAML key, but a description is free text — a `: ` in it, or a leading `#`, `-` or `{`, would otherwise change or break the parse.

## Where the panels open

Each webview panel has its own setting — `tsk.panel.nowStack.openDirection`, `tsk.panel.stats.openDirection`, `tsk.panel.taskList.openDirection` — each accepting `right`, `left`, `above`, `below`, or `active` (a tab in the editor's own group).

They are separate rather than one shared key so that **each default is the placement that panel always had**: Now Stack `right`, Stats and Task List `active`. One key could not default to both.

A direction applies when a panel is **created**, never when an already-open one is revealed — so a panel you have dragged somewhere stays where you put it. `left` / `above` / `below` can't be expressed as a `ViewColumn` (there is no `ViewColumn.Below`), so those create the panel in the editor's group and then split it with VS Code's own group commands; that is why the panel appears for an instant before landing.

## Sections (divider lines)

A line of the form `-label` followed by at least three dashes is a divider — a named section break:

```
-todo-----------------------------------------------------------------------------------------------
```

Each divider gets a **collapsible region** running to the line before the next divider, or to the end of the file. Its trailing dash run is dimmed (the `taskDivider` semantic token) so the label reads as a heading rather than drowning in hyphens. **Tsk: Insert Divider…** prompts for a label and pads the line to `tsk.divider.width` (default 100); run it while the cursor is on an existing divider and the prompt arrives prefilled, which is also how you re-pad one after renaming it. Existing dividers of any width keep working — the setting only shapes new ones.

A divider can't be confused with a task or a bullet: both of those need whitespace after the `-`, and a divider never has any. A bare `---` horizontal rule isn't one either, since the label has to start with a letter or digit.

Note that registering a folding provider *replaces* VS Code's indentation folding for the language rather than adding to it, so tsk's provider emits task-block indentation ranges as well — otherwise adding section folding would quietly remove the task-block folding you already had.

## Linking to files

Write `[[path/to/file.md]]` in a task and Ctrl+Click opens it. Paths resolve **workspace-relative first** (the form these links are usually written in), then relative to the linking file; an absolute path is taken as-is. A link whose target doesn't exist stays a link and says so on hover rather than silently going dead — the span is still there, so a typo is visible instead of just inert. It also raises a warning in the Problems panel, squiggled on the brackets alone. That squiggle covers **open** `.tsk` documents only: a warm start skips unchanged files without reading them, so there is nothing to check them against, and the hover is the signal that is always current (a diagnostic computed on edit can't notice the target being created afterwards).

Add a heading to land on it: `[[plans/x.md#phase-1]]` — the anchor GitHub gives the heading (repeated headings numbered `-1`, `-2`, as GitHub does), or the heading's text. A heading the file doesn't have still opens the file, says so on hover and is squiggled.

Typing `[[` opens path completion over the workspace. Items are labelled by basename with the directory alongside, but **filtered on the full relative path**, so `notes/20` narrows as you'd expect. **`Alt+L`** (*Tsk: Insert Link to File…*) does the same through a quick-pick, and completes an unclosed `[[` in place rather than doubling the brackets. After the path, `#` completes the file's headings (in Markdown and `.tsk` files), listed by their text and in the file's order; picking one inserts its anchor, and typing either the anchor or the heading's words narrows the list.

Every file in the workspace is offered, except the ones **git ignores** — the candidate list comes from `git ls-files`, so `.gitignore` (including nested ones, `.git/info/exclude` and negations) decides what you see, and `node_modules` and build output stay out without any setting to maintain. In a workspace without git, tsk falls back to a plain file search and says so in the Output channel, since it then has no ignore rules to honour.

`[[…]]` deliberately only ever means a file. Task-to-task references are `@parent` / `@relatedTo` / `@dependsOn`, which carry code lenses and graph diagnostics — giving the bracket form a second meaning would make "where does this go?" ambiguous.

## Naming a task from a plan

Write `tsk:<id>` in a Markdown file — a plan naming its tasks — or in a `.tsk` file, and it becomes a link that reveals the task (the tooltip is its text), with the task's **live marker** drawn after it: `tsk:5tdnqp74 [/]`, in the marker's colour, as a `.tsk` file shows it. The marker is redrawn whenever a `.tsk` file is rescanned, so a task finished from the command line shows as `[x]` in the open plan without touching the plan's text. An id no `.tsk` file has gets a muted `[?]` — a typo, or a task since deleted.

Every id the workspace knows is a link, whatever it looks like; an unknown one only when it has the shape `tsk`'s generated ids do (8 characters of its alphabet), so `task tsk:test` in prose stays plain.

The **Markdown preview** shows the same links and markers. A click opens the task through `vscode://garyng.tsk/open?id=<id>` (VS Code may ask once whether the extension may open it), and the open previews are rendered again after each rescan, so their markers stay live too. They're automatic links, so `markdown.preview.linkify` turns them off with the others.

In **VS Code's terminal** a `tsk:<id>` is a link too — in Claude's output, in a tmux pane, whatever printed it — for ids the workspace knows only, since terminal output is noisier and has no marker to flag an unknown one. Hover for the task's text, Ctrl+Click to reveal it. The click also selects it in a running `tsk tui` beside the terminal: one in a pane of the tmux window that terminal shows, or, outside tmux, one following a Claude that runs in it (see `tsk show <id> --tui`, under Command line). That TUI must be showing the task's file; nothing else is asked, so a click beside one Claude never moves another's pane.

**In tmux**, from any terminal (Windows Terminal too), Ctrl+Click on a `tsk:<id>` selects the task in the TUI in that pane's window. tsk's own output writes each id that way on a terminal, in cyan (`NO_COLOR` leaves the colour out), and plain where Claude reads it. A binding in `tmux.conf` runs `tsk select-clicked` with the line, the column and the link under the mouse, then passes the click on to the pane. The TUI's footer says it was asked; when nothing was selected, tmux's message line says why. A terminal that opens links still opens one, so neither tsk nor a reply writes the id as a `vscode://` link; a reply writes it as inline code, which Claude Code colours.

```tmux
bind -n C-MouseDown1Pane {
    send-keys -M
    run-shell -b "tsk select-clicked --pane=#{pane_id} --client=#{q:client_name} --column=#{mouse_x} --line=#{q:mouse_line} --hyperlink=#{q:mouse_hyperlink} >/dev/null"
}
```

## Migrating from Markdown

Bring existing Markdown checklists into tsk. Markdown task lists speak their own marker vocabulary and carry no inline metadata, so the migration commands do two things: **remap the markers** (per the `tsk.migrate.markers` glyph→status map) and **derive the metadata from git history** — `@created` from the commit that added the line, `@completed` / `@cancelled` / `@moved` / `@started` from the commit of the most recent switch *into* the current marker (a task done → reopened → done again stamps the second done; file renames are followed). Every migrated line gains a fresh `@id`. Lines git can't answer for (uncommitted, untracked, not a repo) are stamped with the current time and counted in the summary toast.

- **Tsk: Send All Markdown Tasks to Tsk File…** — the one-shot evacuation: every top-level task block in the `.md` file (or just the blocks your selection touches) is converted and appended, in order, to one `.tsk` file you pick (or a new one via the save dialog), leaving a `[>]` breadcrumb per block. One atomic edit, one undo. Per-task: `Ctrl+.` → *Send task to tsk file…* on any unmigrated task line.
- **Tsk: Migrate Markdown Tasks** — the staged alternative: convert in place (whole file, selection, or `Ctrl+.` → *Migrate task to tsk format* per line). Converted tasks keep living in the `.md` file — the metadata comment is invisible in rendered Markdown — until you relocate them with *Move task to file…*, which auto-converts any still-raw children riding along in the block.
- **Tsk: Migrate Markdown Bullets as Todos** — for checklists that never used checkboxes: a bare `- aaaa` becomes `- [ ] aaaa` with a fresh `@id` plus the same git-derived `@created`. Separate from the command above on purpose — most bullets in a `.md` file are prose, so the task migration never touches them and only this explicit invocation does. Scope is the same (whole file, selection, or `Ctrl+.` → *Migrate bullet to tsk todo* per line); a whole-file run asks first, since that is the one sweep that can turn a page of notes into tasks.

The default vocabulary reads `[ ]` todo, `[/]` **done**, `[>>]` moved, `[x]` **cancelled**, `[n]` note — `[/]` and `[x]` mean different things in tsk, so the remap is semantic, not textual (`[/]` → `[x]` + `@completed`; `[x]` → `[!]` + `@cancelled`). GFM-style lists should override the map, e.g. `{" ": "todo", "x": "completed", "/": "inprogress"}`. Migration only ever touches lines without an `@id` (re-running is harmless), and `- [text](url)` links are never mistaken for tasks — the bullet command treats such a link as the bare bullet it is. Try it hands-on with `docs/migrate-sample.md`.

## Tags & search

Tags use `#tag` and `#tag/sub/leaf` syntax inside `.tsk` files. Several surfaces sit on top:

- **`#`-triggered completion.** Type `#` (or `#partial`) in any `.tsk` editor and a completion list surfaces every known tag. Items merge two sources: tags declared in the workspace `tags.yml` (with descriptions, shown as the item detail) and tags discovered in `.tsk` files via the cache — plus implicit `/`-separated parents, so `#project/tsk` automatically contributes `#project`.
- **`Alt+T` find-all-tasks-by-tag.** Opens a list of every known tag — each row showing a hierarchical task count (`5 tasks · <description>`), searchable by name, count, *and* description — then opens VS Code's **Search Editor** with `#<tag>` pre-queried, scoped to `*.tsk`. You get Ctrl+Click navigation, regex/case toggles, and result folding for free, and the search opens with **0 context lines** so only the matching task rows show. The Search Editor's own grammar can't highlight tsk rows, so the extension paints tsk **decorations** (marker colors, priority backgrounds, dimmed metadata) onto the match rows itself. The per-tag count is prefix-inclusive (a `#project` row counts its `#project/tsk` tasks too), matching what the substring search returns.
- **Find all tasks by status** (Command Palette → *Tsk: Find All Tasks by Status*; palette-only, since `Alt+T` is the tag search). Pick a status marker — each row shows its `[glyph]` and a task count — and it opens the same Search Editor with a line-anchored **regex** (`^\s*[-*+] \[<glyph>\]`) scoped to `*.tsk`, listing every task carrying that marker. The anchor keeps `[ ]` (todo) from matching stray empty brackets in prose; the result rows get the same tsk decorations as the tag search.
- **Populate `tags.yml` from your tags** (Command Palette → *Tsk: Add Discovered Tags to tags.yml*). Appends every tag used on a task that isn't declared yet as a bare stub under a dated `# discovered <date>` header — **append-only**, so existing entries and comments are untouched — ready for you to fill in a `description` / `parent`. Literal tags only (implicit `/`-parents aren't auto-added); re-running adds only what's new. Creates the file if it doesn't exist.

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

## Link status

A link in a `.tsk` editor can show its status after it: a ticket's or a PR's state as a rounded chip in the colour of its kind (open, in progress, done, closed), with a `✓` / `✗` / `○` for its CI checks when the connector reports them. Hover the link or the chip for the title, the rest of what the connector said and when it was fetched, with **Open** and **Refresh**; `Ctrl`/`Cmd`+Click on the chip opens the link. Three kinds of link count: bare `http(s)` URLs, Markdown `[text](url)`, and *Autolinks* matches, by the URL they point to.

The chip takes its room in the line as a blank inlay hint as wide as it, and is drawn over that: VS Code counts an inlay hint when it wraps a line, and not text an extension draws. That needs inlay hints shown all the time (`editor.inlayHints.enabled` set to `on`, the default), without padding, and in the editor's own font and size. Otherwise the chip sits in the line itself, and a line that wraps can overflow by its chips.

Only the links on screen are fetched, and a screen above and below, as you scroll; a file with hundreds of links costs a request or two per screen. Statuses are kept across reloads, per workspace, so a file you reopen shows them at once and only the stale ones are fetched again: an open item after 5 minutes, a finished one after a day, a failed lookup after a minute. Only a link some connector takes shows one: when the connectors change, the statuses none of them takes are dropped. **Tsk: Refresh Link Status** fetches the ones on screen again; **Tsk: Clear Link Status Cache** forgets every status, then fetches the ones on screen.

A **connector** fetches the status. Yours are programs, in `tsk.linkStatus.connectors`:

```jsonc
"tsk.linkStatus.connectors": [
  { "name": "tickets", "match": "^https://tickets\\.example\\.com/", "command": ["/home/me/bin/ticket-status", "--json"] }
]
```

- **`match`**: a regular expression tested against each link's URL. The first connector that matches takes the link.
- **`command`**: the program and its arguments, run without a shell in the workspace folder (a leading `~/` is the home folder). tsk writes a batch of URLs to its stdin, one per line, then closes it, and reads one JSON object per line from its stdout: `{"url": …, "label": "In review", "category": "inProgress"}`, with `checks` (`passing`, `failing`, `pending`), `title` and `lines` (an array of strings) for the hover if it has them, or `{"url": …, "error": "why"}`. `category` is one of `open`, `inProgress`, `done`, `failed`, `closed`, `unknown`. A URL left out of the answer has no status, and its hover says so.
- **`batchSize`**: at most this many URLs per run (default 20, at most 100). A run has 30 seconds; its stderr goes to the *Tsk* Output channel, and a non-zero exit fails the batch with stderr's last line.

**GitHub** is built in. Turn on `tsk.linkStatus.github.enabled`, and a PR link shows its state (`open`, `draft`, `merged`, `closed`) with its CI checks, and an issue link its own (closed as completed counts as done, not planned as closed). The hover adds `owner/repo#n · @author` and, on an open PR, its review (`approved`, `changes requested`, `review required`). It uses VS Code's own GitHub sign-in, with the `repo` scope that private repos need (GitHub's OAuth has no read-only form of it): with no session, a link's hover offers **Sign in to GitHub** (or run *Tsk: Sign In to GitHub for Link Status*), and signing in, out or as someone else fetches what's on screen again. A GitHub Actions link, to a run, one attempt of it or a job, shows GitHub's own word for it: its status until it finishes (`queued`, `in progress`), its conclusion after (`success`, `failure`, `cancelled`), a failure in the `failed` colour. The hover adds the run's title, its workflow and number, the branch and who started it; on a job, the step that failed. Up to 50 PR and issue links go in one GraphQL query, and an Actions link is a REST request of its own, in batches of 10, two batches at once; when GitHub's rate limit runs out, it waits until GitHub says. A connector of yours whose `match` takes a GitHub URL comes first.

**Jira Cloud** is built in too, for any number of sites: a link to an issue on any `https://<site>.atlassian.net` (`/browse/KEY`, a board's `selectedIssue=KEY`) is a Jira link, pasted or an autolink's target, so the autolink that turns `#ABC-123` into its site's link picks the site. Each site has its own email and API token, kept in VS Code's secret storage: run *Tsk: Set Jira API Token*, or follow the link in the hover of an issue on a site with none (it fills the site in). A site with none kept is never asked. The status shows the issue's status, coloured by Jira's own status category (to do, in progress, done), and the hover adds the summary, the key and the assignee. Up to 100 issues go in one request per site. Jira Cloud takes an **API token** with the account's email, not a personal access token (those are Jira Server's): create one at id.atlassian.com, *Security*, *API tokens*. One **with scopes** is the safer kind, and `read:jira-work` is the only scope it needs; tsk finds the gateway such a token must go through by itself. A token lasts at most a year: when Jira refuses it, the hover says so and links to setting a new one.

A connector runs a program, so the setting is read only in a trusted workspace (tsk doesn't run in an untrusted one at all). A repo's own `.vscode/settings.json` can name one, as its tasks can run one, and the program runs in the workspace folder, so a relative path is from there: `["node", "tools/ticket-status.mjs"]`. `docs/link-status-sample.mjs` is a sample connector that makes statuses up; `docs/demo.tsk` shows how to try it. The colours are themable: `tsk.linkStatus.{open,inprogress,done,failed,closed,unknown}`, the chip's text and, at 18% over the editor's background, its fill.

## Relationships, code lenses & navigation

Every task with relationship metadata grows code lenses showing forward edges (`parent: <id>` / `dependsOn: <id>` / `relatedTo: <id>` / `movedTo: <id>`; a task that waits on several — `@dependsOn:a,b` — gets a `dependsOn:` lens per id) and inverse edges (`children: N` / `dependents: N` / `related: N` / `movedHereFrom: N`). `@movedTo` (a `[>]` task's "moved to" pointer) is a first-class graph edge: it shows the forward `movedTo: <id>` lens, the move target gains an inverse `movedHereFrom: N` lens, and a dangling `@movedTo` squiggles like any other broken reference. Each title is prefixed with a [codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html) hinting the relationship type.

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

These commands are invoked by lens clicks and by the hover's links — no palette entries, no keybindings.

**Canonical-occurrence gating.** Lenses render only on the canonical occurrence of an `@id` (the lex-lowest `(file, line)` in the workspace). Duplicate-`@id` losers get a diagnostic squiggle pointing at the canonical winner instead of a potentially misleading lens.

**Navigation highlight.** Clicking a forward-edge lens (parent / dependsOn / relatedTo / movedTo) lands on the target line and leaves a soft whole-line tint there until your next interaction. It's persistent, not a flash — it clears on the next navigate, a user-initiated cursor move in that editor, or the active editor moving off it. Theme it via `workbench.colorCustomizations` and the `tsk.navigation.highlight` color id (default: soft yellow with alpha, readable on light and dark themes).

**Reveal a task by id.** *Tsk: Reveal Task by ID* asks for an id — `tsk:<id>` and `@id:<id>` work as pasted — and opens the task wherever it is, in the tab already showing its file if there is one, with the navigation highlight. From outside VS Code, `vscode://garyng.tsk/open?id=<id>` does the same: an OSC 8 link in a terminal, a link in a browser, anything that opens URLs.

## Now task & tree

`Alt+W` (**Tsk: Mark Now**) marks the task under the cursor as your current "now". In a single undo step it stamps a missing `@id` (+ `@created`) and — unless you turn off `tsk.now.autoInProgress` — flips the marker to `[/]` and stamps `@started`, the same transition the `Alt+S` in-progress toggle applies. The current now-task carries a persistent border around its line (the `tsk.now.highlight` color), a box kept visually distinct from the priority line-background tint.

Marks accumulate into an **undo-tree**, not a stack: each new mark becomes a child of the current one, and switching to an earlier node and marking again *branches* rather than overwriting — history is never pruned implicitly. Open the tree from the `target` button in a `.tsk` editor's title bar, or **Tsk: Open Now Stack**. It's a React webview that docks **beside** the file like a Markdown preview (and pops out via *Move / Copy into a New Window*), rendered with [`@grida/tree-view`](https://grida.co/packages/@grida/tree-view) for a native tree feel — keyboard nav (`↑`/`↓` move, `←`/`→` collapse/expand, `Enter` jumps), twisties, collapse-state that persists.

The tree uses **linear-compaction**: the path from root to the current now renders as a flat trunk (current at the top), and only real branches indent — so a mostly-linear history stays flat instead of deeply nested.

| Action | What it does |
|--------|--------------|
| **Click a node** | Jump to that task. Reuses the editor beside the panel (a task in another file opens in that group — never a stray tab over the panel). Read-only; never edits. |
| **Set as current** | Switch the now-pointer to that node. Undo / redo is a pointer move — nothing is deleted. |
| **Bump** | Lift the node to the top **and** make it the current now — **jumping to the task** and flipping it to `[/]` in-progress (like `Alt+W`, configurable via `tsk.now.autoInProgress`), no new node, no branch. Its children stay where they are (they do *not* travel with it); the tree heals around the moved node so nothing else is disturbed. Contrast *Set as current* (a pointer move that leaves the node in place) and marking (which adds a *child*). |
| **Back** (toolbar) | Switch to the current node's parent (undo one step). |
| **Remove** | Drop one node, re-parenting its children onto its parent. |
| **Delete branch** | Drop a node and its whole subtree. |
| **Remove children** | Drop a node's descendants, keeping the node itself. |
| **Prune off-path** (toolbar) | Drop every branch not on the path to the current now (linearize). |
| **Clear** (toolbar, or **Tsk: Clear Now History**) | Wipe the whole tree — confirm via a notification toast (not a blocking modal); your tasks are untouched. |

**Persistence.** The now-tree lives in its own SQLite `state.db` (default `${workspaceStorage}/state.db`, set via `tsk.state.path`; see *Where tsk keeps its databases*) — **separate from `cache.db`**, so **Tsk: Rebuild Cache** leaves it intact. With no workspace folder it's session-only (in-memory). Like the cache, it's single-root today.

**Recurrence.** The same task can appear at several nodes (mark it, move on, come back later) — a node's identity is its position in the tree, not the `@id`, so one task can sit at multiple points in your history.

**Limits (v1).** No in-panel search/filter; a now-task in a *closed* file shows no in-editor highlight (only the tree label); `@movedTo` isn't followed; multi-root workspaces aren't supported yet (same as the cache).

## Stats & task list

Two more React webview panels visualize every task in the workspace, opened from the Command Palette:

- **Tsk: Open Stats** — a GitHub-style **activity calendar** of task events (created / started / completed / cancelled / moved) with a metric toggle, above a row of current-status **count tiles** (todo / in-progress / done / …). It reads the `@created` / `@started` / `@completed` timestamps tsk stamps on each status transition, scales its squares to fit the panel width (so a whole year stays visible in a narrow panel), and tracks your theme. Those stamps are written only when you toggle via the commands — and `@started` / `@completed` clear on toggle-back — so the calendar reflects tasks *currently* bearing each stamp: a best-effort history, not an append-only log.
- **Tsk: Open Task List** — every task in a **searchable, sortable table**: a fuzzy content search, a relative `Created` column (newest first, hover for the exact time), coloured `P1/P2/P3` priority badges (`@priority:1–3`), and **Excel-style header filter dropdowns** on Status, Tags, and Priority — and on **Session**, a column that appears once any task carries an `@session` (the short id of the Claude session that last took it on through the `tsk` command line) — faceted, multi-select, with a search box for tags. The status chips (each showing its marker glyph + live count) are one-click quick-filters over the same Status filter, and a **Current file** toggle narrows the list to the `.tsk` file you're editing — following you as you switch editors (off by default; disabled until a `.tsk` file is active). A row click reveals the task beside the panel. Virtualized for large workspaces. The persistent, browse-and-stay companion to *Tsk: Find All Tasks by Status* (which stays the fast keyboard path).

Both refresh live as you edit and revive after a window reload. `docs/many-tasks.tsk` is a ready-made backlog for trying them out.

## Hover

Hovering a task surfaces a Markdown popup of its parsed metadata, so you needn't decode the dimmed `<!-- … -->` comment by eye. It lists the `@id`, each timestamp rendered both absolutely and as friendly relative time (`… (3 days ago)`), the tags, and any relationship links — each link a clickable command URI that jumps to the referenced task. The task content itself is deliberately *not* repeated (it's already under your cursor). Document-local, so it works on untitled buffers too.

## Code actions & diagnostics

`Ctrl+.` helpers:

- **Add missing id.** A markered task with no `@id` (any marker, not only `[ ]`) offers *"Tsk: Add missing id + created"* (or *"…Add missing id"* when `@created` is already present), writing the same metadata `Alt+A` would. Unlike the `Alt+A` toggle — which fires only on its own target marker — the quick-fix is marker-agnostic, so you can promote a hand-typed `- [x] done` imported from elsewhere.
- **Broken references.** When a task's `@parent` / `@dependsOn` / `@relatedTo` / `@movedTo` points at an `@id` with no canonical occurrence in the workspace, the line gets a `Warning` squiggle. The lightbulb offers *"Tsk: Remove broken @parent"* (or `@movedTo`, etc.) to drop it, or *"Tsk: Replace @parent via picker…"* to pick a real task. In a `@dependsOn` list each unknown id is its own warning, and its fixes (*"Tsk: Remove broken @dependsOn:<id>"*) touch only that id.

- **Duplicate `@id`.** Every occurrence after the first offers *"Tsk: Regenerate @id (resolve duplicate)"*, giving that occurrence a fresh id and leaving the canonical one alone.

Warnings surface in both the `tsk` Output channel and the Problems panel: duplicate `@id`, task-without-`@id`, broken `@parent` / `@dependsOn` / `@relatedTo` / `@movedTo` references, and `[[links]]` to missing files.

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

On activation, tsk scans every `.tsk` file git doesn't ignore (a workspace without git falls back to a search that skips `node_modules` and `.git`) and indexes tasks into a SQLite cache that powers tag search and the relationship graph:

- Default location `${workspaceStorage}/cache.db`, configurable via `tsk.cache.path`. Falls back to in-memory when no workspace folder is open.
- File events (watcher, save, debounced edit) trigger per-file rescans; reopening preserves data. A new file comes in only if the scan would list it, so a nested repository's files stay out (an agent's git worktree, a copy of the same tasks), as git leaves them out. A deleted folder takes its files out of the cache, and the next activation drops any file that went while VS Code was away.
- Run **Tsk: Rebuild Cache** to purge and rerun the initial scan if anything looks stale.

### Where tsk keeps its databases

`cache.db` and the now-tree's `state.db` (each with its `-wal` and `-shm`) go in `${workspaceStorage}`: tsk's folder in VS Code's own storage for the workspace, outside the folder, so a folder tsk opens in stays as it was. On a remote (a container, SSH) that's on the remote. To keep them in the folder instead, say for a container rebuilt without VS Code's server data, set `tsk.cache.path` and `tsk.state.path` to `${workspaceFolder}/.vscode/tsk/cache.db` and `${workspaceFolder}/.vscode/tsk/state.db`, or any other path.

Up to 0.15 both defaulted to `.vscode/tsk`. A database still there, whose setting is at its default, moves on the first open: the now-tree is copied to `${workspaceStorage}`, the cache is removed (it's rebuilt), and `.vscode/tsk` goes when that empties it.

## Command line (`tsk`)

The package also ships a `tsk` command for tracking work in a `.tsk` file from a terminal — written for coding agents such as Claude Code, which can sidetrack from one task into another and another until the thread is lost. Build it with `npm run build:cli` and put `bin/tsk` on your `PATH`.

```sh
tsk push "fix the parser"    # start a sidetrack under what you're doing, and focus it
tsk add "write a test"       # queue a task for later, under the focus
tsk done                     # finish the focus; focus falls back to its parent
tsk trail                    # root → focus, and everything still open
tsk dep <id> --on <a> --on <b>   # <id> can't start until a and b are done
tsk ready                    # what can start now, in the focus's plan
tsk reword <id> "new text"   # change a task's text; its [[links]] and metadata stay
tsk delegate <id> --to alpha # hand a task to a subagent; the focus stays
tsk commit                   # commit the file whole, the message naming each session's changes
```

`tsk --help` lists the rest (`focus`, `park`, `cancel`, `dep --off`, `link`, `show`, `ls`). Every task it writes is an ordinary tsk line, so the file stays readable and editable by hand, and the extension sees the changes like any other.

- **Which file:** `--file`, else `TSK_FILE`, else the nearest `claude.tsk` above the working directory.
- **Which session:** `--session`, else `TSK_SESSION`, else `CLAUDE_CODE_SESSION_ID`, shortened to 8 characters. A task carries `@session:<id>` for the session that last took it on, and `@focused:<time>` for when — to the millisecond, so two calls in the same second still say which came last.
- **Focus is worked out from the file:** a session's focus is its in-progress task with the latest `@focused`, so finishing or parking it falls back to the next one — normally its parent — and nothing is stored outside the file.
- **Handing work to agents:** a subagent (or an in-process teammate) runs under its session's id, so its own `tsk` calls would move the session's focus. The session hands it the task instead: `tsk delegate <id> --to <name>`, or `--to <name>` on `push` / `add`, starts it with `@agent:<name>` and leaves the focus where it was (the focus itself falls back to the next). `tsk trail` lists the session's open tasks with agents in a block of their own, each with its agent's name, until `tsk done <id>` closes one on the agent's report; `tsk focus <id>` takes it back and `tsk park <id>` leaves it for later, each dropping `@agent`.
- **Nesting is the tree, up to four levels.** A sidetrack deeper than that is written flat at the fourth level with `@parent:<id>`, so a long chain can't push the file off-screen; an explicit `@parent` always beats indentation.
- **Dependencies:** `@dependsOn:a,b` lists what a task waits on. A task waits on its own open dependencies and on those of every task it sits under (the sub-steps of a phase that waits wait too); a dependency that isn't in the file holds it back as well. **An id the file doesn't have is looked for in the other `.tsk` files beside it** (at a repo root, say, `stack.tsk` next to `claude.tsk`), read and never written: a task can wait on one there, `show` names that file after it, and `tsk dep --on` accepts its id; the TUI shows those tasks in the dependency and Steps views with their file, read-only (`e` opens them), and redraws when any `.tsk` file beside it changes. `tsk dep` refuses one that would close a loop and prints the loop. `tsk ready` lists the `[ ]` tasks nothing holds back — under the focus's top-level task, under `<id>`, or `--all`; `show` lists a task's dependencies and dependents, and `trail` / `ls` mark a waiting task with what it waits on.
- **A live view:** `tsk tui` shows the file in the terminal and redraws whenever anyone changes it. The views are tabs along the top — Session, Tree and Steps; `1`–`3` jump to one, `tab` / `shift-tab` cycle. The session view puts the focus at the top with the path above it as a breadcrumb, then the tasks handed to agents under `agents`, each with its agent's name, then the session's other open tasks; `enter` zooms into a task, `e` opens the task in VS Code, `s` switches tmux to the pane of the Claude on the task's session (its `@session`, else its nearest ancestor's; `prefix L` comes back), and the footer shows the keys that apply to the selected task, labelled as they'd act now (`space fold` or `space unfold`), the way back first in the dependency view, wrapping onto more rows when they don't fit on one (the presets and the list of states do too), and only as tall as what it shows; `?` lists every key, grouped, a long line wrapping under its own text (it scrolls with `j` / `k` when the pane is short, and `?` or Esc closes it). A message (red for an error) takes the footer's place for a few seconds. A task's state is its shape — `○` open, `◐` in progress, `✓` done, `✕` cancelled, `→` moved — and dim tree lines (`│` `└`) show where it sits. The selected row is tinted with the accent colour, its text undimmed so a finished task stays readable, and the session's focus is marked `◆`; long tasks wrap under their own text instead of being cut, and `↑ N more` / `↓ N more` say what's scrolled out of view. A task shows `◀N` after its text for the dependencies it still waits on and `▶N` for the open tasks waiting on it (the extension's dependsOn / dependents lens icons); `d` shows what the selected task needs (followed back) and what needs it (`esc` goes back), and the Steps view puts the file's open dependencies in steps — step 1 is what can start now, each later step waits only on earlier ones. In the Tree view `space` folds the selected task's subtree, or unfolds it, and on a task with nothing under it folds its parent; `z` folds everything and `Z` unfolds it all. A folded task shows `▸` before its state, and a dim `+N` for the tasks it hides; the folds are the pane's own, never written to the file. `/` filters the Tree view (from another view it switches there): as you type in the footer, the tree narrows to the tasks whose text, as the row shows it, holds every word you type, or whose `@id` starts with one, ignoring case — each in the tasks it sits in, dimmed — with the words highlighted (a task found by its id shows it), the first match selected and the folds set aside; up and down move the selection while you type. Enter keeps the filter (`/query` beside the tabs, and `/` again edits it); Esc clears it, in the prompt or after. It narrows within a zoom and the states shown too. The Tree view opens on the open tasks (todo and in progress). `a` offers presets in the footer: `open`, `in progress`, `closed` (done, cancelled and moved), `all` and `pick…`. A preset's first letter picks it at once (`a a` shows everything, `a o` goes back), as do `h` / `l` and Enter; Esc leaves it as it was. `pick…` opens a list of the states to show, ticked like a spreadsheet column's filter, each a checkbox (`■` shown, `□` left out) with the one under the cursor tinted as the selected row is: `h` / `l` move, `space` ticks, Enter keeps it and Esc leaves it as it was. A task in a state left out goes, unless something under it shows, and then it stays, dimmed; while a state is left out, the tab strip shows the ones in view (`· ○◐`). Colours are the extension's marker colours; the TUI asks the terminal for its background (OSC 11, falling back to `COLORFGBG`, then dark) to mix the tint and pick the light or dark set, and `NO_COLOR` turns colour off (the selection becomes inverse). `p` shows or hides the detail pane — under the list, or beside it from 100 columns, shown by default in a terminal 24 rows or taller: the selected task's facts (state, stamps, session and agent, where it sits, what it waits on and what needs it, its children), then the plan it links to (its own `[[link]]`, else its nearest linked ancestor's), rendered and opened at the line naming `tsk:<id>`, redrawn when the file changes. `J` / `K` and `PgDn` / `PgUp` scroll it without moving the selection; `o` opens the file in VS Code at the line in view; `+` / `-` make it bigger or smaller and `=` puts it back. The mouse works too: a click selects a row, a double-click zooms in, the wheel scrolls whichever pane is under it without moving the selection, dragging the detail pane's edge resizes it, and the tabs, the breadcrumb, the `↑/↓ N more` lines and the footer's hints are clickable; `--no-mouse` (or `TSK_NO_MOUSE`) leaves the mouse to the terminal, and Shift-drag selects text either way. `--follow-pid <pid>` follows a running Claude Code process, so the view moves along when `/clear` or `/branch` gives the conversation a new session, and `m` sends that session a message about the selected task, or about every task marked with `v` (a `●` in the gutter, the count on the footer's right; `v` again unmarks one, Esc all of them). The pane never changes the file itself: you ask, and the session makes the change with `tsk`, so its own record stays right. `m` opens a box in the footer, with the terminal's own cursor. Enter sends what's typed, and nothing when nothing is; shift+enter (or alt+enter, ctrl+j, `\` before Enter) starts a new line, a paste keeps its line breaks, and the footer grows to five rows; the shell's line keys edit it (`ctrl+w` / `alt+backspace` / `ctrl+backspace` a word back, `ctrl+left` / `ctrl+right`, `ctrl+u` / `ctrl+k`, …), reported in kitty's or xterm's extended form or not; Esc on an empty box cancels, and on a typed one a second Esc clears it. The message goes to the session's cross-session inbox socket, mid-turn too (it's read between tool calls), and leaves the session's focus where it was; the footer shows the latest one until the session's transcript says it was read (`→ <id> queued 1:20`); long chains of sidetracks stay flat (only a task with several children indents) so it fits a narrow side pane.
- **Beside Claude in tmux:** `tsk tmux-pane` opens the live view in a tmux pane beside a Claude Code session, following it: a quarter of the Claude pane's width, on its right, with the keyboard left on Claude. From Claude's own shell it's that Claude (`$CLAUDE_PID`); from anywhere else in the window, the Claude in the active pane, else in the pane you came from (so with several Claudes, select the one to follow, then type it in a shell beside it), else the window's only one. A window gets one per Claude: when a view already follows it there, it prints that pane instead. `--here` runs the view in the current pane, following the window's Claude. Outside tmux it prints the `tsk tui --follow-pid <pid>` to run in another terminal.
- **Pointing the TUI at a task:** `tsk show <id> --tui` selects the task in a running `tsk tui` instead of printing it — in the view that shows it, else in the Tree view with whatever hides it there (a zoom, a fold, the filter, the states shown) set aside — and the footer says it was asked from outside. From a Claude Code session's shell it asks only the TUI following that Claude, so one session can't move another's pane; otherwise the TUIs showing the session (`--session`, `TSK_SESSION`, …), else the only one open on the file. It prints where the task was selected, or why not: none is open, or the TUI is busy because a note or a filter is being typed, which a request never interrupts. Each TUI listens on a Unix socket in `$TMPDIR/tsk-<uid>/` (`TSK_RUNTIME_DIR` puts it elsewhere), a directory only you can open, beside a record of the file it shows and the Claude or session it follows; a request can only move the selection, never change the file.
- **Committing it:** `tsk commit` commits the file as it stands, every session's tasks together, through an index of its own, so nothing else that's staged goes in with it. The message names each changed task (`done tsk:<id> <title>`, `added …`, `reworded …`), grouped by its session; focus stamps alone aren't listed. One session's lines can't be committed on their own: `@session` says who owns a task, not who last changed it, and a new task can sit under another session's uncommitted one. The repository's hooks and config apply as for `git commit`, and nothing is pushed.
- **Several writers at once:** each change locks the file (a `<file>.lock` directory, via `proper-lockfile`), re-reads it, edits the task found by `@id`, and writes it back atomically (temp file + rename, via `write-file-atomic`). An editor isn't part of the lock, but VS Code and vim both refuse to save over a file that changed under unsaved edits without asking.

## Settings

Every user-facing setting lives in `package.json#contributes.configuration`; the defaults below are the manifest's.

| Setting | Default | Description |
|---------|---------|-------------|
| `tsk.cache.path` | `${workspaceStorage}/cache.db` | On-disk SQLite cache (`${workspaceStorage}` and `${workspaceFolder}` expanded at runtime; in-memory when no workspace folder is open). See *Where tsk keeps its databases*. |
| `tsk.tags.path` | `${workspaceFolder}/.vscode/tsk/tags.yml` | Workspace `tags.yml` for tag descriptions + completion. Blank ⇒ no file loaded (tags discovered in `.tsk` files still complete). |
| `tsk.log.level` | `info` | `tsk` Output-channel verbosity: `debug` / `info` / `warn` / `error`. |
| `tsk.editor.changeDebounceMs` | `300` | Debounce (ms) before re-applying priority decorations / rescanning a `.tsk` document after a text change (range 0–5000). Marker + metadata colors are semantic tokens and update independently of this. |
| `tsk.decorations.priority.opacity` | `0.15` | Background opacity (0–1) of priority line tints; applies live. |
| `tsk.clipboard.bridgeEnabled` | `false` | Master switch for the clipboard bridge (watch a file → host clipboard). |
| `tsk.clipboard.bridgePath` | `${workspaceFolder}/.vscode/tsk/clipboard-bridge.txt` | The watched bridge file; only used when the bridge is enabled. |
| `tsk.pasteImage.baseDirectory` | `./images` | Base directory (under the document) for pasted images. Blank ⇒ beside the document. |
| `tsk.state.path` | `${workspaceStorage}/state.db` | On-disk SQLite store for the now-tree, separate from the cache (survives **Rebuild Cache**). In-memory when no workspace folder is open. |
| `tsk.now.autoInProgress` | `true` | When marking a task as "now" (`Alt+W`), also flip its marker to `[/]` and stamp `@started` (like `Alt+S`). Turn off to leave the marker unchanged. |
| `tsk.autolinks` | `[]` | Regex→URL rules; text matching a rule becomes a `Ctrl`/`Cmd`+clickable link in `.tsk` editors. See *Autolinks*. |
| `tsk.linkStatus.github.enabled` | `false` | The status of GitHub PR, issue and Actions links, through VS Code's GitHub sign-in. See *Link status*. |
| `tsk.linkStatus.connectors` | `[]` | Programs that fetch the status shown after links in `.tsk` editors, by URL pattern. User settings only. See *Link status*. |
| `tsk.migrate.markers` | `[/]`=done, `[x]`=cancelled, … | Markdown glyph → tsk status map used by the migration commands (multi-char glyphs like `>>` allowed). See *Migrating from Markdown*. |
| `tsk.doubleClickSelectsBlock` | `true` | Double-click a task's marker / bullet / indentation in a `.tsk` editor to select its whole block; double-clicking the task's text still selects a word. Off ⇒ default word-select everywhere. See *List editing*. |
| `tsk.blockTrailingNewline` | `true` | Include the trailing line break when operating on a whole task block — `Ctrl+C` / `Ctrl+X` copy/cut (nothing selected) and double-click / `Tsk: Select Task Block` selection all extend through it, so a block is a self-contained unit on its own line. Off ⇒ block operations end at the block's last character. See *List editing*. |
| `tsk.panel.nowStack.openDirection` | `right` | Where the Now Stack panel opens: `right` / `left` / `above` / `below` / `active` (a tab in the editor's group). Applied when the panel is created, never on reveal. See *Where the panels open*. |
| `tsk.panel.stats.openDirection` | `active` | Same, for the Stats panel. |
| `tsk.panel.taskList.openDirection` | `active` | Same, for the Task List panel. |
| `tsk.divider.width` | `100` | Column width *Tsk: Insert Divider…* pads a divider to. Existing dividers of any width keep working. See *Sections*. |

Themable colors are also contributed (override via `workbench.colorCustomizations`): `tsk.marker.{todo,inprogress,completed,moved,cancelled,notes}`, `tsk.metadata.foreground`, `tsk.navigation.highlight`, `tsk.now.highlight`, and the link status colours (see *Link status*). The marker and metadata colors drive the **Search Editor result rows** (which can't carry semantic tokens); `tsk.navigation.highlight` and `tsk.now.highlight` are in-editor line decorations (the navigation highlight and the now-task border). In `.tsk` editors, markers and metadata recolor via `editor.semanticTokenColorCustomizations` instead (see *Marker, priority & metadata coloring*).

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
npm run build          # host (dist/host/extension.cjs) + webview (dist/webview/{now-stack,stats,task-list}.js)
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
npm run test:e2e:all   # stable, then floor
```

`.vscode-test.mjs` defines labeled configurations:

- **`stable`** — downloads the latest VS Code at run time. Catches the "newest still works" signal.
- **`floor`** — pinned to VS Code `1.112.0`, the engine floor. Catches the "minimum supported still works" signal. Together with a strict-subset `@types/vscode@~1.110` typecheck (1.110 is the closest published type package at or below the floor; anything that typechecks against that subset is guaranteed to run on 1.112+), this is the second of two layers holding the codebase to the floor. The floor config carries a more generous mocha timeout (60s) — extension-host startup and config-change propagation are slower on the 1.112 host in a devcontainer.
- **`bench`** — not a test: the file-search benchmark, run with `task bench:file-search` against a large workspace (`TSK_BENCH_WORKSPACE`). With no `--label`, `vscode-test` runs every configuration, so `test:e2e:all` names `stable` and `floor` explicitly.

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
npm run package        # @vscode/vsce packages dist/ → artifacts/tsk-<version>.vsix (build first)
```

### Architecture

Pure, vscode-free logic lives in `src/lib/**` and is unit-tested with vitest (parser, metadata serializer, marker/priority registries, graph builder, cache helpers, list-edit and toggle logic, …). The thin glue that touches the VS Code API lives in `src/*` next to `extension.ts` and is exercised by the e2e suites. Markers and priorities are driven by single-source registries (`src/lib/markers.ts`, `src/lib/priorities.ts`) mirrored into `package.json` and the grammar, with a drift test keeping them in sync — adding a marker is a registry entry plus the mirror.

### Conventions

- Pure logic in `src/lib/**` is unit-tested (vitest); user-visible behavior is e2e-tested (`@vscode/test-cli`). A feature is incomplete without both.
- After every user-visible feature lands, `docs/demo.tsk` is updated to exercise it.
- Detailed scoped rules: see [`CLAUDE.md`](./CLAUDE.md).

### Contributing

This extension is developed inside a larger private monorepo and published here as a standalone repository with **one commit per release** — `tsk: <version>`, holding the extension exactly as it stood when that version was cut. The individual changes behind each release live in the monorepo. Please file **issues** on this repo. **Pull requests** are welcome too, but because the monorepo is authoritative, an accepted PR is applied there and ships here in the next release commit — so your PR will be closed with an "included in `tsk: <version>`" note rather than merged directly. For a small fix, an issue with a diff is the quickest path.
