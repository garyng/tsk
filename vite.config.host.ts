import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';
import { watchPolling } from './vite.watch';

// The extension runs in VS Code's Node-based host, so every Node built-in and
// the `vscode` API must stay external — Vite must not bundle or browser-polyfill
// them. We externalize by predicate, not a fixed list: `builtinModules` only
// enumerates prefix-only modules like `node:sqlite` / `node:test` on newer Node
// releases, so a list derived from it silently drops `node:sqlite` when the
// build runs under Node 22. Vite then stubs it as `__vite_browser_external` and
// `new DatabaseSync()` throws "is not a constructor". Matching any `node:`
// specifier sidesteps that version dependence.
const isExternal = (id: string) =>
    id === 'vscode' || id.startsWith('node:') || builtinModules.includes(id);

// `dev:host` runs with `--mode development` so the watch build stays
// non-minified — readable identifiers in CPU profiles and debugger frames,
// which minified output mangles even with a source map. `build:host` /
// `package` (default production mode) keep minification (Oxc, Vite 8's
// default) for a smaller .vsix.
export default defineConfig(({ mode }) => ({
    build: {
        lib: {
            entry: 'src/extension.ts',
            formats: ['cjs'],
            fileName: (format) => (format === 'cjs' ? 'extension.cjs' : `extension.${format}.js`),
        },
        target: 'node22',
        outDir: 'dist/host',
        sourcemap: true,
        emptyOutDir: true,
        minify: mode !== 'development',
        // Poll only where file events never arrive (a 9p-shared Windows drive; see
        // vite.watch.ts). Gated on dev mode so the one-shot production `build` stays
        // event-free (no accidental watch). Same root cause as the clipboard bridge (M22).
        watch:
            mode === 'development'
                ? { chokidar: { usePolling: watchPolling(process.cwd()), interval: 300 } }
                : null,
        rollupOptions: {
            external: isExternal,
        },
    },
}));
