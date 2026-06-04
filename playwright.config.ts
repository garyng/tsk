import { defineConfig } from '@playwright/test';

/**
 * Visual + smoke tests for the now-stack WEBVIEW. They load the actual built
 * `dist/webview/now-stack.js` into a headless Chromium with a mocked
 * `acquireVsCodeApi`, so they exercise the same bundle the panel ships — catching
 * browser-only failures the host-side `@vscode/test-cli` e2e can't see (the
 * webview renders in an isolated iframe). The blank-panel `process is not
 * defined` bug, for instance, surfaces here as a page error + a missing root.
 *
 * Screenshots are golden-compared. The goldens are generated + checked in inside
 * this devcontainer; Playwright suffixes them per-platform, so regenerate with
 * `npm run test:webview:update` if the rendering environment changes.
 */
export default defineConfig({
    testDir: './tests/webview',
    fullyParallel: true,
    reporter: [['list']],
    use: {
        browserName: 'chromium',
        viewport: { width: 480, height: 320 },
        colorScheme: 'dark',
    },
    expect: {
        // Tolerate sub-pixel font-rendering noise between runs.
        toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
    },
});
