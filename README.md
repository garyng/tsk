# tsk

A markdown-based task manager VSCode extension. Works on `.tsk` files, enriching markdown task lists with inline metadata, tags, relationship graphs, code lenses, and a queryable cache.

Currently in **early development (M0 complete)** — the extension activates and registers stub commands, but features land milestone-by-milestone. The implementation plan lives at [`plans/2026-05-24_tsk.md`](../../plans/2026-05-24_tsk.md).

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
  extension.ts          # activate/deactivate, output channel, command registration
  lib/                  # pure logic (parser, cache, graph, logger) — unit-tested
tests/
  e2e/                  # @vscode/test-cli suites — run inside a real VSCode host
docs/
  demo.tsk              # living end-to-end showcase, grown by each milestone
```

## Conventions

- Pure logic in `src/lib/**` is unit-tested with vitest; user-visible behavior is e2e-tested with `@vscode/test-cli`. A feature is incomplete without both.
- After every user-visible feature lands, `docs/demo.tsk` is updated to exercise it.
- Detailed scoped rules: see [`CLAUDE.md`](./CLAUDE.md).
