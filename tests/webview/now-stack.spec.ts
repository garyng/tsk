import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import type { Marker } from '../../src/lib/markers';

/**
 * The now-stack webview is SERVED from a fake origin (via `page.route` in
 * {@link mount}) rather than injected inline, so the entry's ESM imports — notably
 * the shared React chunk Vite emits across the webview entries — resolve against
 * the page origin. `npm run test:webview` builds `dist/webview` first; serving the
 * real files keeps the test exercising the shipped artifact. The bundle injects
 * its own `<style>` on load, so the harness only supplies the editor-like backdrop.
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
    <script type="module" src="/now-stack.js"></script>
</body>
</html>`;

/**
 * A resolved, linear-compaction viewmodel (the §step-8 shape): trunk C◉/B/A with
 * D under B and a missing E under A. Exercises the current highlight, two
 * twisties (B, A are forks), a missing-task label, and the relative-time column.
 */
const SAMPLE_ROWS = [
    row(
        'C',
        'B',
        0,
        'trunk',
        false,
        true,
        true,
        'Write the parser',
        '2 minutes ago',
        true,
        'inprogress',
    ),
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
        'completed',
    ),
    row(
        'D',
        'B',
        1,
        'branch',
        false,
        false,
        false,
        'Add unit tests',
        '8 minutes ago',
        true,
        'todo',
    ),
    row(
        'A',
        null,
        0,
        'trunk',
        true,
        true,
        false,
        'Ship phase 7',
        'about 1 hour ago',
        true,
        'inprogress',
    ),
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
    marker?: Marker,
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
        marker,
    };
}

/** A flat linear chain (no branches): current at top, all depth 0, no twisties. */
const LINEAR_ROWS = [
    row(
        'L3',
        'L2',
        0,
        'trunk',
        false,
        true,
        true,
        'Wire the keymap',
        'just now',
        true,
        'inprogress',
    ),
    row(
        'L2',
        'L1',
        0,
        'trunk',
        false,
        true,
        false,
        'Refactor the panel',
        '5 minutes ago',
        true,
        'completed',
    ),
    row(
        'L1',
        null,
        0,
        'trunk',
        false,
        true,
        false,
        'Open the now stack',
        'an hour ago',
        true,
        'completed',
    ),
];

/** A no-current forest (e.g. after removing the current root): two depth-0 roots, nothing marked. */
const FOREST_ROWS = [
    row(
        'F1',
        null,
        0,
        'branch',
        false,
        false,
        false,
        'Orphaned root one',
        '2 hours ago',
        true,
        'completed',
    ),
    row(
        'F2',
        null,
        0,
        'branch',
        false,
        false,
        false,
        'Orphaned root two',
        '3 hours ago',
        true,
        'cancelled',
    ),
];

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
    // Serve the harness + the built webview files from a fake origin so the
    // entry's ESM imports (e.g. the shared React chunk) resolve — inline injection
    // can't resolve `./chunk.mjs`, an intercepted origin can.
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
    // The twistie flips to chevron-right; D is gone.
    await expect(page).toHaveScreenshot('now-stack-tree-collapsed.png');
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

// ── every row action button ───────────────────────────────────────────────

for (const [label, expected] of [
    ['Set as current now', { type: 'switchTo', entryId: 'B' }],
    ['Remove children', { type: 'pruneChildren', entryId: 'B' }],
    ['Remove this entry', { type: 'remove', entryId: 'B' }],
    ['Delete this branch', { type: 'pruneSubtree', entryId: 'B' }],
] as const) {
    test(`row action "${label}" posts ${expected.type}`, async ({ page }) => {
        await render(page);
        const rowB = page.locator('[data-tree-row-id="B"]');
        await rowB.hover();
        await rowB.getByRole('button', { name: label }).click();
        expect(await posted(page)).toContainEqual(expected);
    });
}

// ── every toolbar button ──────────────────────────────────────────────────

test('toolbar prune-off-path posts pruneOffPath', async ({ page }) => {
    await render(page);
    await page.getByRole('button', { name: 'Prune off-path branches' }).click();
    expect(await posted(page)).toContainEqual({ type: 'pruneOffPath' });
});

test('toolbar reveal-current is webview-only (no host message, no error)', async ({ page }) => {
    const errors = await mount(page);
    await page.evaluate((rows) => window.postMessage({ type: 'render', rows }, '*'), SAMPLE_ROWS);
    await expect(page.locator('.now-row')).toHaveCount(5);
    await page.getByRole('button', { name: 'Reveal current now' }).click();
    const actions = (await posted(page)).filter((m) => (m as { type: string }).type !== 'ready');
    expect(actions).toEqual([]); // reveal() + scrollIntoView are local
    expect(errors).toEqual([]);
});

// ── keyboard navigation (validates the Enter→activate keymap) ───────────────

test('keyboard: ArrowDown focuses the first row', async ({ page }) => {
    await render(page);
    await page.locator('.now-tree').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.now-row[data-focused]')).toHaveCount(1);
    await expect(page.locator('[data-tree-row-id="C"][data-focused]')).toBeVisible();
});

test('keyboard: Enter jumps the focused row', async ({ page }) => {
    await render(page);
    await page.locator('.now-tree').focus();
    await page.keyboard.press('ArrowDown'); // focus C
    await page.keyboard.press('Enter');
    expect(await posted(page)).toContainEqual({ type: 'jump', id: 't-C' });
});

test('keyboard: ArrowLeft collapses a focused fork, ArrowRight re-expands', async ({ page }) => {
    await render(page);
    await page.locator('.now-tree').focus();
    await page.keyboard.press('ArrowDown'); // C
    await page.keyboard.press('ArrowDown'); // B (a fork)
    await expect(page.locator('[data-tree-row-id="B"][data-focused]')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('[data-tree-row-id="D"]')).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-tree-row-id="D"]')).toBeVisible();
});

// ── visual / structural states ─────────────────────────────────────────────

test('exactly the current row shows the circle-filled marker', async ({ page }) => {
    await render(page);
    await expect(page.locator('.now-row__icon .codicon-circle-filled')).toHaveCount(1);
    await expect(page.locator('[data-tree-row-id="C"] .codicon-circle-filled')).toBeVisible();
});

test('rich-renders each resolved row with its decorated marker glyph', async ({ page }) => {
    await render(page);
    // The four resolved rows carry a colored [glyph]; the unresolved E has none.
    await expect(page.locator('.now-row__marker')).toHaveCount(4);
    await expect(
        page.locator('[data-tree-row-id="C"] .now-row__marker[data-marker="inprogress"]'),
    ).toBeVisible();
    await expect(page.locator('[data-tree-row-id="E"] .now-row__marker')).toHaveCount(0);
});

test('an unresolved task renders the italic missing-label style', async ({ page }) => {
    await render(page);
    await expect(page.locator('.now-row__label--missing')).toHaveCount(1);
    await expect(page.locator('[data-tree-row-id="E"] .now-row__label--missing')).toBeVisible();
});

test('forks render a chevron codicon; leaves do not', async ({ page }) => {
    await render(page);
    await expect(page.locator('[data-tree-row-id="B"] .codicon-chevron-down')).toBeVisible();
    await expect(page.locator('[data-tree-row-id="A"] .codicon-chevron-down')).toBeVisible();
    await expect(page.locator('[data-tree-row-id="C"] .codicon-chevron-down')).toHaveCount(0);
});

test('re-expanding a collapsed fork by twistie restores its offshoot', async ({ page }) => {
    await render(page);
    const twistie = page.locator('[data-tree-row-id="B"] .now-row__twistie');
    await twistie.click();
    await expect(page.locator('[data-tree-row-id="D"]')).toHaveCount(0);
    await twistie.click();
    await expect(page.locator('[data-tree-row-id="D"]')).toBeVisible();
});

// ── different tree shapes ──────────────────────────────────────────────────

test('a second render with a different shape replaces the tree', async ({ page }) => {
    await render(page); // 5-row §step-8 tree
    await page.evaluate((rows) => window.postMessage({ type: 'render', rows }, '*'), LINEAR_ROWS);
    await expect(page.locator('.now-row')).toHaveCount(3);
    await expect(page.locator('.now-row .codicon-chevron-down')).toHaveCount(0); // no forks
});

test('renders a flat linear chain (no twisties, current at top)', async ({ page }) => {
    const errors = await mount(page);
    await page.evaluate((rows) => window.postMessage({ type: 'render', rows }, '*'), LINEAR_ROWS);
    await expect(page.locator('.now-row')).toHaveCount(3);
    await expect(page.locator('.now-row[data-state="current"]')).toHaveCount(1);
    expect(errors).toEqual([]);
    await expect(page).toHaveScreenshot('now-stack-tree-linear.png');
});

test('renders a no-current forest (no current marker)', async ({ page }) => {
    const errors = await mount(page);
    await page.evaluate((rows) => window.postMessage({ type: 'render', rows }, '*'), FOREST_ROWS);
    await expect(page.locator('.now-row')).toHaveCount(2);
    await expect(page.locator('.now-row[data-state="current"]')).toHaveCount(0);
    await expect(page.locator('.codicon-circle-filled')).toHaveCount(0);
    expect(errors).toEqual([]);
    await expect(page).toHaveScreenshot('now-stack-tree-forest.png');
});
