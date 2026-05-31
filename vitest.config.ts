import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/lib/**'],
            reporter: ['text', 'html'],
            // M11/A: lock in a coverage floor on the pure layer. Only
            // enforced under `npm test -- --coverage` (instrumentation
            // slows iteration, so we don't bake `--coverage` into the
            // bare `npm test` command). Threshold is global (across all
            // included files), not per-file — per-file would block
            // adding small new modules until they're exhaustively tested.
            thresholds: {
                lines: 80,
                functions: 80,
                statements: 80,
                branches: 80,
            },
        },
    },
});
