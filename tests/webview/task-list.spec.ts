import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * The task-list webview, SERVED from a fake origin (so the entry + its chunks
 * resolve like a real panel) with a mocked `acquireVsCodeApi`. `npm run
 * test:webview` builds `dist/webview` first.
 */
const WEBVIEW_DIR = 'dist/webview';
const ORIGIN = 'http://tsk.test';

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
    <script type="module" src="/task-list.js"></script>
</body>
</html>`;

const VIEW = {
    rows: [
        {
            id: 't1',
            marker: 'inprogress',
            content: 'refactor the cache',
            file: 'foo.tsk',
            line: 4,
            tags: ['infra', 'perf'],
            created: '2026-06-07T11:50:00+00:00',
        },
        {
            id: 't2',
            marker: 'todo',
            content: 'write the parser',
            file: 'foo.tsk',
            line: 0,
            tags: ['infra'],
            created: '2026-06-05T09:00:00+00:00',
        },
        {
            id: 't3',
            marker: 'completed',
            content: 'ship phase 7',
            file: 'bar.tsk',
            line: 12,
            tags: [],
            created: '2026-05-20T09:00:00+00:00',
        },
        {
            id: 't4',
            marker: 'todo',
            content: 'add tests',
            file: 'bar.tsk',
            line: 13,
            tags: ['testing'],
            created: undefined,
        },
    ],
    counts: [
        { marker: 'todo', label: 'Todo', count: 2 },
        { marker: 'inprogress', label: 'In progress', count: 1 },
        { marker: 'completed', label: 'Completed', count: 1 },
        { marker: 'moved', label: 'Moved', count: 0 },
        { marker: 'cancelled', label: 'Cancelled', count: 0 },
        { marker: 'notes', label: 'Notes', count: 0 },
    ],
    total: 4,
};

const posted = (page: Page): Promise<unknown[]> =>
    page.evaluate(() => (window as unknown as { __posted: unknown[] }).__posted);

async function mount(page: Page, view: unknown = VIEW): Promise<string[]> {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });
    await page.route(`${ORIGIN}/**`, (route) => {
        const { pathname } = new URL(route.request().url());
        if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: HARNESS });
        try {
            const body = readFileSync(join(WEBVIEW_DIR, pathname), 'utf8');
            const contentType = pathname.endsWith('.map') ? 'application/json' : 'text/javascript';
            return route.fulfill({ contentType, body });
        } catch {
            return route.fulfill({ status: 404, body: '' });
        }
    });
    await page.goto(`${ORIGIN}/`);
    await page.locator('.tsk-tasks').waitFor();
    await page.evaluate((v) => window.postMessage({ type: 'render', view: v }, '*'), view);
    await page.locator('.tsk-row').first().waitFor();
    return errors;
}

test('mounts cleanly and renders a chip per status plus All', async ({ page }) => {
    const errors = await mount(page);
    expect(errors).toEqual([]);
    await expect(page.locator('.tsk-chip')).toHaveCount(7); // All + 6 markers
    await expect(page.getByRole('button', { name: /^All/ })).toContainText('4');
});

test('lists task rows with content and file:line', async ({ page }) => {
    await mount(page);
    await expect(page.locator('.tsk-row')).toHaveCount(4);
    const row = page.locator('.tsk-row', { hasText: 'refactor the cache' });
    await expect(row.locator('.tsk-cell[data-col="loc"]')).toHaveText('foo.tsk:5'); // line 4 → 1-indexed 5
});

test('filtering by a status chip shows only that status', async ({ page }) => {
    await mount(page);
    await page.getByRole('button', { name: /In progress/ }).click();
    await expect(page.locator('.tsk-row')).toHaveCount(1);
    await expect(page.locator('.tsk-row')).toContainText('refactor the cache');
});

test('clicking a row posts a jump carrying the task @id', async ({ page }) => {
    await mount(page);
    await page.locator('.tsk-row', { hasText: 'write the parser' }).click();
    expect(await posted(page)).toContainEqual({ type: 'jump', id: 't2' });
});
