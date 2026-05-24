import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// Externalize Node built-ins (both bare `fs` and `node:fs` forms) plus the
// `vscode` API surface, which the extension host provides at runtime.
const nodeExternals = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
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
        rollupOptions: {
            external: ['vscode', ...nodeExternals],
        },
    },
});
