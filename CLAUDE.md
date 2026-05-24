# apps/tsk — scoped rules

Rules in this file apply to all work under `apps/tsk` (the `tsk` VSCode extension). They augment the repo-root `CLAUDE.md`.

## Demo file

- After implementing any new user-visible feature, **always** update `apps/tsk/docs/demo.tsk` to showcase it. The demo file is the living end-to-end demonstration of every feature the extension currently supports — opening it in the Extension Development Host should exercise everything.
- Treat the demo file as a regression artefact: if a feature change leaves it unchanged but should have, that's incomplete work. If a feature change makes it look broken, that's a bug.

## Tests

- **Always** write tests for new functionality. A feature is incomplete until both layers below are covered:
  - **Unit (`vitest`)** for pure logic — parser, metadata serializer, nanoid alphabet, tag hierarchy resolver, graph builder, cache helpers, anything in `src/lib/**`. Place tests next to the code as `*.test.ts`.
  - **End-to-end (`@vscode/test-cli`)** for user-visible behavior — commands, keybindings, decorations, codelens, navigation, autocompletion, anything that requires a real VSCode host. Place tests under `tests/e2e/**/*.test.ts`.
- When fixing a bug, add a failing test first; then make it pass.

## Plan reference

The current implementation plan lives at `plans/2026-05-24_tsk.md`. As work progresses, update the milestone checkboxes there (`[ ]` → `[/]` while in progress → `[x]` when done).
