import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    files: 'out-test/e2e/**/*.test.js',
    workspaceFolder: 'tests/e2e/fixtures/workspace',
    mocha: {
        ui: 'tdd',
        timeout: 20000,
    },
});
