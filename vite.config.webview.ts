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
