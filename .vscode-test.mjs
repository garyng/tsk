import { defineConfig } from '@vscode/test-cli';

/**
 * Test configurations, by label:
 *
 *   - `stable` — default. Runs against whatever the latest VS Code release
 *     is at download time. Catches the "newest still works" signal.
 *   - `floor` — runs against VS Code 1.112 (the engine floor declared in
 *     package.json#engines.vscode). Catches the "minimum supported still
 *     works" signal — together with the strict-subset `@types/vscode@~1.110`
 *     typecheck, this is the second of two layers that pin us to the floor.
 *   - `bench` — not a test: the file-search benchmark (`task bench:file-search`).
 *
 * Pick with `vscode-test --label <name>`. With NO label, vscode-test runs every
 * configuration — the benchmark included — which is why `test:e2e:all` names
 * `stable` and `floor` explicitly instead of relying on that.
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
        // Benchmarks, not tests: the thing measured is how file search
        // behaves on a LARGE tree, so the workspace comes from
        // TSK_BENCH_WORKSPACE (the `bench:file-search` task passes the root
        // of whatever repository it runs in). Never part of `test:e2e`.
        ...baseConfig,
        label: 'bench',
        files: 'out-test/tests/bench/**/*.test.js',
        workspaceFolder: process.env.TSK_BENCH_WORKSPACE ?? baseConfig.workspaceFolder,
        mocha: { ...baseConfig.mocha, timeout: 300000 },
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
