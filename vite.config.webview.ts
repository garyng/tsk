import { defineConfig } from 'vite';

// The "now stack" webview client — a small React app bundled to a single ESM
// file the panel loads via `asWebviewUri`. Unlike the host build, this is a
// BROWSER bundle: nothing is externalized (React + ReactDOM are bundled in), and
// JSX is transformed by esbuild's automatic runtime (no @vitejs/plugin-react, so
// no Vite-major plugin-compat coupling).
//
// Host and webview build into SEPARATE subdirs (`dist/host` + `dist/webview`),
// each with its own `emptyOutDir`, so they never clobber each other — build
// order is irrelevant and `dev:host` / `dev:webview` can watch concurrently.
export default defineConfig(({ mode }) => ({
    // React + ReactDOM read `process.env.NODE_ENV` to choose dev vs prod code
    // paths. Vite does NOT inject this replacement in LIBRARY mode (only in app
    // builds), so without it the bundle ships a bare `process.env.NODE_ENV`,
    // throws `process is not defined` in the webview (no Node `process` in the
    // browser), and React never mounts — a blank panel. Replace it at build time.
    define: {
        'process.env.NODE_ENV': JSON.stringify(mode === 'development' ? 'development' : 'production'),
    },
    build: {
        outDir: 'dist/webview',
        emptyOutDir: true,
        sourcemap: true,
        minify: mode !== 'development',
        lib: {
            entry: 'src/webview/now-stack/main.tsx',
            formats: ['es'],
            fileName: () => 'now-stack.js',
        },
    },
    esbuild: {
        jsx: 'automatic',
        jsxImportSource: 'react',
    },
}));
