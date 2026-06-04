import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

/**
 * The built webview bundle, loaded as text and injected as a module script. It's
 * self-contained (React + grida are bundled in, no imports), so it runs
 * standalone in a blank page once `acquireVsCodeApi` is mocked. `npm run
 * test:webview` builds it first; reading it here keeps the test exercising the
 * real shipped artifact. The bundle injects its own `<style>` on load, so the
 * harness only supplies the editor-like backdrop.
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
</style>
</head>
<body>
    <div id="root"></div>
    <script>
        window.__posted = [];
        let __state;
        window.acquireVsCodeApi = () => ({
            postMessage: (m) => window.__posted.push(m),
            getState: () => __state,
            setState: (s) => { __state = s; },
        });
    </script>
</body>
</html>`;

/**
 * A resolved, linear-compaction viewmodel (the §step-8 shape): trunk C◉/B/A with
 * D under B and a missing E under A. Exercises the current highlight, two
 * twisties (B, A are forks), a missing-task label, and the relative-time column.
 */
const SAMPLE_ROWS = [
    row('C', 'B', 0, 'trunk', false, true, true, 'Write the parser', '2 minutes ago', true),
    row(
        'B',
        'A',
        0,
        'trunk',
        true,
        true,
        false,
        'Refactor the cache layer',
        '10 minutes ago',
        true,
    ),
    row('D', 'B', 1, 'branch', false, false, false, 'Add unit tests', '8 minutes ago', true),
    row('A', null, 0, 'trunk', true, true, false, 'Ship phase 7', 'about 1 hour ago', true),
    row(
        'E',
        'A',
        1,
        'branch',
        false,
        false,
        false,
        '(missing in workspace)',
        'about 1 hour ago',
        false,
    ),
];

function row(
    entryId: string,
    parentId: string | null,
    depth: number,
    kind: 'trunk' | 'branch',
    isFork: boolean,
    onCurrentPath: boolean,
    current: boolean,
    label: string,
    when: string,
    resolved: boolean,
) {
    return {
        entryId,
        parentId,
        depth,
        kind,
        isFork,
        onCurrentPath,
        current,
        id: `t-${entryId}`,
        label,
        when,
        resolved,
    };
}

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

/** Messages the bundle has posted back to the (mocked) host. */
const posted = (page: Page): Promise<unknown[]> =>
    page.evaluate(() => (window as unknown as { __posted: unknown[] }).__posted);

/** Mount + push the sample tree, returning once the rows are on screen. */
async function render(page: Page): Promise<void> {
    await mount(page);
    await page.evaluate((rows) => window.postMessage({ type: 'render', rows }, '*'), SAMPLE_ROWS);
    await expect(page.locator('.now-row')).toHaveCount(5);
}

test('mounts with no runtime errors and shows the empty state', async ({ page }) => {
    const errors = await mount(page);
    await expect(page.locator('.now-stack__empty')).toBeVisible();
    // The assertion that catches `process is not defined`: a crashing bundle
    // records a pageerror and never mounts the root.
    expect(errors).toEqual([]);
    await expect(page).toHaveScreenshot('now-stack-empty.png');
});

test('an empty render keeps the empty state', async ({ page }) => {
    const errors = await mount(page);
    await page.evaluate(() => window.postMessage({ type: 'render', rows: [] }, '*'));
    await expect(page.locator('.now-stack__empty')).toBeVisible();
    expect(errors).toEqual([]);
});

test('a populated render builds the compacted grida tree', async ({ page }) => {
    const errors = await mount(page);
    await page.evaluate((rows) => window.postMessage({ type: 'render', rows }, '*'), SAMPLE_ROWS);
    await expect(page.locator('.now-tree')).toBeVisible();
    // grida flattens the synthetic tree back to our five compacted rows.
    await expect(page.locator('.now-row')).toHaveCount(5);
    // exactly the current row is highlighted; B and A render a twistie.
    await expect(page.locator('.now-row[data-state="current"]')).toHaveCount(1);
    expect(errors).toEqual([]);
    await expect(page).toHaveScreenshot('now-stack-tree.png');
});

test('collapsing a fork hides its offshoot', async ({ page }) => {
    await render(page);
    // Click fork B's twistie → its child D disappears (5 → 4 rows).
    await page.locator('[data-tree-row-id="B"] .now-row__twistie').click();
    await expect(page.locator('.now-row')).toHaveCount(4);
    await expect(page.locator('[data-tree-row-id="D"]')).toHaveCount(0);
});

test('keeps a fork collapsed across a re-render', async ({ page }) => {
    await render(page);
    await page.locator('[data-tree-row-id="B"] .now-row__twistie').click();
    await expect(page.locator('.now-row')).toHaveCount(4); // D hidden under collapsed B
    // Re-send the SAME rows (as a store onDidChange would) → B stays collapsed.
    await page.evaluate((rows) => window.postMessage({ type: 'render', rows }, '*'), SAMPLE_ROWS);
    await expect(page.locator('[data-tree-row-id="D"]')).toHaveCount(0);
    await expect(page.locator('.now-row')).toHaveCount(4);
});

test('reveals the codicon row actions on hover', async ({ page }) => {
    await render(page);
    await page.locator('[data-tree-row-id="B"]').hover();
    await expect(page.locator('[data-tree-row-id="B"] .now-row__actions')).toBeVisible();
    await expect(page).toHaveScreenshot('now-stack-tree-hover.png');
});

test('clicking a row posts a jump carrying the task @id', async ({ page }) => {
    await render(page);
    await page.locator('[data-tree-row-id="C"]').click();
    expect(await posted(page)).toContainEqual({ type: 'jump', id: 't-C' });
});

test('a row action button posts its action with the entryId', async ({ page }) => {
    await render(page);
    const rowB = page.locator('[data-tree-row-id="B"]');
    await rowB.hover(); // actions are hover-revealed
    await rowB.getByRole('button', { name: 'Set as current now' }).click();
    expect(await posted(page)).toContainEqual({ type: 'switchTo', entryId: 'B' });
});

test('toolbar buttons post the tree-level actions', async ({ page }) => {
    await render(page);
    await page.getByRole('button', { name: 'Back (switch to parent)' }).click();
    await page.getByRole('button', { name: 'Clear now history' }).click();
    const messages = await posted(page);
    expect(messages).toContainEqual({ type: 'back' });
    expect(messages).toContainEqual({ type: 'clear' });
});

test('posts {type:"ready"} to the host on mount', async ({ page }) => {
    await mount(page);
    expect(await posted(page)).toContainEqual({ type: 'ready' });
});
