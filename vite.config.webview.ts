import { defineConfig } from 'vite';

// The webview clients — small React apps, one SELF-CONTAINED ESM bundle per entry
// (`now-stack` · `stats` · `task-list`), each loaded by its panel via
// `asWebviewUri`. Unlike the host build, these are BROWSER bundles: nothing is
// externalized (React + ReactDOM are bundled into each), and JSX is transformed
// by esbuild's automatic runtime (no @vitejs/plugin-react, so no Vite-major
// plugin-compat coupling).
//
// One entry is built per invocation (selected by `TSK_WV_ENTRY`, default
// `now-stack`). A single multi-ENTRY build would hoist the shared React into a
// sibling ESM chunk that each entry imports — which the panel's strict nonce CSP
// can't authorize (`script-src 'nonce-…'` blocks an un-nonced sibling import →
// blank panel), and which the Playwright harness can't resolve (it injects the
// bundle inline, with no base URL). Building each entry alone keeps every bundle
// import-free. The build script runs this once per entry; see `build:webview`.
//
// Host and webview build into SEPARATE subdirs (`dist/host` + `dist/webview`) so
// they never clobber each other.
const WEBVIEW_ENTRIES = {
    'now-stack': 'src/webview/now-stack/main.tsx',
    stats: 'src/webview/stats/main.tsx',
    'task-list': 'src/webview/task-list/main.tsx',
} as const;

export default defineConfig(({ mode }) => {
    const entry = (process.env.TSK_WV_ENTRY ?? 'now-stack') as keyof typeof WEBVIEW_ENTRIES;
    const entryPath = WEBVIEW_ENTRIES[entry];
    if (!entryPath) {
        const known = Object.keys(WEBVIEW_ENTRIES).join(', ');
        throw new Error(`Unknown TSK_WV_ENTRY "${entry}" (expected one of: ${known})`);
    }
    return {
        // React + ReactDOM read `process.env.NODE_ENV` to choose dev vs prod code
        // paths. Vite does NOT inject this replacement in LIBRARY mode (only in app
        // builds), so without it the bundle ships a bare `process.env.NODE_ENV`,
        // throws `process is not defined` in the webview (no Node `process` in the
        // browser), and React never mounts — a blank panel. Replace it at build time.
        define: {
            'process.env.NODE_ENV': JSON.stringify(
                mode === 'development' ? 'development' : 'production',
            ),
        },
        build: {
            outDir: 'dist/webview',
            // Never wipe between the per-entry builds (they share this outDir) —
            // `build:webview` cleans the dir once up front via `clean:webview`.
            emptyOutDir: false,
            sourcemap: true,
            minify: mode !== 'development',
            // Some bind mounts (9p/drvfs and similar) deliver no inotify events, so
            // poll or `--watch` never fires. Gated on dev mode so the one-shot
            // production build stays unwatched. See vite.config.host.ts for the full
            // rationale.
            watch:
                mode === 'development' ? { chokidar: { usePolling: true, interval: 300 } } : null,
            lib: {
                entry: entryPath,
                formats: ['es'],
                fileName: () => `${entry}.js`,
            },
        },
        esbuild: {
            jsx: 'automatic',
            jsxImportSource: 'react',
        },
    };
});
