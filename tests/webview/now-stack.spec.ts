import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

/**
 * The built webview bundle, loaded as text and injected as a module script. It's
 * self-contained (React is bundled in, no imports), so it runs standalone in a
 * blank page once `acquireVsCodeApi` is mocked. `npm run test:webview` builds it
 * first; reading it here keeps the test exercising the real shipped artifact.
 */
const bundle = readFileSync('dist/webview/now-stack.js', 'utf8');

const HARNESS = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #1e1e1e; color: #cccccc;
           font: 13px/1.5 system-ui, "Segoe UI", sans-serif; }
    .now-stack { padding: 12px; }
</style>
</head>
<body>
    <div id="root"></div>
    <script>
        window.__posted = [];
        window.acquireVsCodeApi = () => ({
            postMessage: (m) => window.__posted.push(m),
            getState: () => undefined,
            setState: () => {},
        });
    </script>
</body>
</html>`;

/**
 * Mount the built bundle into a blank page with a mocked vscode API, returning
 * the collected runtime + console errors (empty = clean). If the bundle crashes
 * on load (e.g. `process is not defined`), `.now-stack` never appears and the
 * `waitFor` below throws — so this fails loudly two ways.
 */
async function mount(page: Page): Promise<string[]> {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });
    await page.setContent(HARNESS);
    await page.addScriptTag({ content: bundle, type: 'module' });
    await page.locator('.now-stack').waitFor();
    return errors;
}

test('mounts with no runtime errors and shows the empty state', async ({ page }) => {
    const errors = await mount(page);
    await expect(page.locator('.now-stack__empty')).toBeVisible();
    // The assertion that catches `process is not defined`: a crashing bundle
    // records a pageerror and never mounts the root.
    expect(errors).toEqual([]);
    await expect(page).toHaveScreenshot('now-stack-empty.png');
});

test('a render message switches to the rendered state', async ({ page }) => {
    const errors = await mount(page);
    await page.evaluate(() => window.postMessage({ type: 'render' }, '*'));
    await expect(page.locator('.now-stack__placeholder')).toBeVisible();
    expect(errors).toEqual([]);
    await expect(page).toHaveScreenshot('now-stack-rendered.png');
});

test('posts {type:"ready"} to the host on mount', async ({ page }) => {
    await mount(page);
    const posted = await page.evaluate(
        () => (window as unknown as { __posted: unknown[] }).__posted,
    );
    expect(posted).toContainEqual({ type: 'ready' });
});
