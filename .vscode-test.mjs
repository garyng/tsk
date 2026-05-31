import { defineConfig } from '@vscode/test-cli';

/**
 * E2E configurations. Two labels:
 *
 *   - `stable` — default. Runs against whatever the latest VS Code release
 *     is at download time. Catches the "newest still works" signal.
 *   - `floor` — runs against VS Code 1.112 (the engine floor declared in
 *     package.json#engines.vscode). Catches the "minimum supported still
 *     works" signal — together with the strict-subset `@types/vscode@~1.110`
 *     typecheck, this is the second of two layers that pin us to the floor.
 *
 * Pick with `vscode-test --label <name>`. The `test:e2e` script runs `stable`
 * by default; `test:e2e:floor` runs the floor; `test:e2e:all` runs both in
 * sequence.
 */
const baseConfig = {
    files: 'out-test/tests/e2e/**/*.test.js',
    workspaceFolder: 'tests/e2e/fixtures/workspace',
    mocha: {
        ui: 'tdd',
        timeout: 20000,
    },
};

export default defineConfig([
    {
        ...baseConfig,
        label: 'stable',
    },
    {
        ...baseConfig,
        label: 'floor',
        version: '1.112.0',
        // The 1.112 host's extension-host startup and config-change /
        // file-watcher propagation are measurably slower in our
        // devcontainer than on `stable`. Raise the per-test timeout so
        // genuinely correct tests don't trip on host slowness. Behavior
        // is unchanged — only the deadline budget moves.
        mocha: { ...baseConfig.mocha, timeout: 60000 },
    },
]);
