import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// Externalize Node built-ins (both bare `fs` and `node:fs` forms) plus the
// `vscode` API surface, which the extension host provides at runtime.
const nodeExternals = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

// `dev:host` runs with `--mode development` so the watch build stays
// non-minified — readable identifiers in CPU profiles and debugger frames,
// which minified output mangles even with a source map. `build:host` /
// `package` (default production mode) keep esbuild minification for a smaller
// .vsix.
export default defineConfig(({ mode }) => ({
    build: {
        lib: {
            entry: 'src/extension.ts',
            formats: ['cjs'],
            fileName: (format) => (format === 'cjs' ? 'extension.cjs' : `extension.${format}.js`),
        },
        target: 'node22',
        outDir: 'dist',
        sourcemap: true,
        emptyOutDir: true,
        minify: mode !== 'development',
        rollupOptions: {
            external: ['vscode', ...nodeExternals],
        },
    },
}));
