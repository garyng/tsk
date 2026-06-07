import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * The stats webview is SERVED from a fake origin (via `page.route`) so the entry
 * and its lazily-imported chunks (`react-activity-calendar` + the floating-ui
 * tooltip) resolve like a real panel. `npm run test:webview` builds `dist/webview`
 * first; serving the real files keeps the test on the shipped artifact.
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
    <script type="module" src="/stats.js"></script>
</body>
</html>`;

/** A representative {@link StatsView}: counts for every status + a few event days. */
const VIEW = {
    tiles: [
        { marker: 'todo', label: 'Todo', count: 5 },
        { marker: 'inprogress', label: 'In progress', count: 2 },
        { marker: 'completed', label: 'Completed', count: 8 },
        { marker: 'moved', label: 'Moved', count: 1 },
        { marker: 'cancelled', label: 'Cancelled', count: 0 },
        { marker: 'notes', label: 'Notes', count: 3 },
    ],
    total: 19,
    series: {
        all: [
            { date: '2026-05-10', count: 3 },
            { date: '2026-05-12', count: 1 },
        ],
        created: [{ date: '2026-05-10', count: 2 }],
        started: [{ date: '2026-05-11', count: 1 }],
        completed: [{ date: '2026-05-12', count: 1 }],
        cancelled: [],
        moved: [],
    },
    range: { from: '2026-01-01', to: '2026-12-31' },
};

/**
 * Serve the built webview from a fake origin, mount, push `view` the way the host
 * does, and resolve once the calendar is on screen. Returns runtime/console
 * errors (empty = clean).
 */
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
    await page.locator('.tsk-stats').waitFor();
    await page.evaluate((v) => window.postMessage({ type: 'render', view: v }, '*'), view);
    // `.tsk-stats__calendar svg` also matches the 5 legend swatches; the calendar
    // itself is the first (and the only one carrying the library's class).
    await page.locator('svg.react-activity-calendar__calendar').waitFor();
    return errors;
}

test('mounts cleanly and renders a tile per status with its count', async ({ page }) => {
    const errors = await mount(page);
    expect(errors).toEqual([]);
    await expect(page.locator('.tsk-tile--total .tsk-tile__count')).toHaveText('19');
    await expect(page.locator('.tsk-tile[data-marker]')).toHaveCount(6);
    await expect(page.locator('.tsk-tile[data-marker="completed"] .tsk-tile__count')).toHaveText(
        '8',
    );
    await expect(page.locator('.tsk-tile[data-marker="cancelled"] .tsk-tile__count')).toHaveText(
        '0',
    );
});

test('renders the metric toggle with All active by default', async ({ page }) => {
    await mount(page);
    await expect(page.locator('.tsk-chip')).toHaveCount(6);
    await expect(page.locator('.tsk-chip--active')).toHaveText('All');
});

test('renders the activity calendar as an SVG of day blocks', async ({ page }) => {
    await mount(page);
    const blocks = page.locator('svg.react-activity-calendar__calendar rect');
    expect(await blocks.count()).toBeGreaterThan(50);
});

test('sizes the calendar to fit the panel width (no horizontal overflow)', async ({ page }) => {
    await mount(page);
    // The ResizeObserver must scale the blocks so the whole grid fits the panel —
    // a regression (e.g. the observer never attaching) leaves it at full size and
    // overflowing.
    const box = await page.locator('svg.react-activity-calendar__calendar').boundingBox();
    const viewport = page.viewportSize();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(viewport?.width ?? 0);
});

test('switching metric updates the active chip', async ({ page }) => {
    await mount(page);
    await page.getByRole('button', { name: 'Completed' }).click();
    // The active chip now carries its marker glyph + label, so match loosely.
    await expect(page.locator('.tsk-chip--active')).toContainText('Completed');
});

test('surfaces the best-effort caveat only for a metric with no events', async ({ page }) => {
    await mount(page);
    await expect(page.locator('.tsk-stats__note')).toHaveCount(0); // 'all' has events
    await page.getByRole('button', { name: 'Cancelled' }).click();
    await expect(page.locator('.tsk-stats__note')).toBeVisible();
});


