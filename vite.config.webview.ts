import { defineConfig } from 'vite';

// The webview clients — small React apps, one ESM bundle per entry (`now-stack` ·
// `stats` · `task-list`), each loaded by its panel via `asWebviewUri`. Unlike the
// host build, these are BROWSER bundles: nothing is externalized (React +
// ReactDOM are bundled), and JSX is transformed by esbuild's automatic runtime
// (no @vitejs/plugin-react, so no Vite-major plugin-compat coupling).
//
// Multiple entries → Vite/Rollup hoists the shared React into one chunk the
// entries import. That's fine here, and is the standard VS Code + Vite webview
// pattern: the panel CSP allows scripts from the extension's own origin
// (`script-src ${webview.cspSource}`, locked to `dist/webview` by
// `localResourceRoots`), so the sibling chunk loads. See `webview-html.ts`.
//
// Host and webview build into SEPARATE subdirs (`dist/host` + `dist/webview`) so
// they never clobber each other.
export default defineConfig(({ mode }) => ({
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
        emptyOutDir: true,
        sourcemap: true,
        minify: mode !== 'development',
        // Some bind mounts (9p/drvfs and similar) deliver no inotify events, so
        // poll or `--watch` never fires. Gated on dev mode so the one-shot
        // production build stays unwatched. See vite.config.host.ts for the full
        // rationale.
        watch: mode === 'development' ? { chokidar: { usePolling: true, interval: 300 } } : null,
        lib: {
            entry: {
                'now-stack': 'src/webview/now-stack/main.tsx',
                stats: 'src/webview/stats/main.tsx',
                'task-list': 'src/webview/task-list/main.tsx',
            },
            formats: ['es'],
            fileName: (_format, entryName) => `${entryName}.js`,
        },
    },
    esbuild: {
        jsx: 'automatic',
        jsxImportSource: 'react',
    },
}));
