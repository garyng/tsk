import { builtinModules } from 'node:module';
import { defaultServerConditions, defaultServerMainFields, defineConfig } from 'vite';

// The `tsk` command line: one ESM file Node runs directly (`bin/tsk`), its
// dependencies bundled in. ESM because the TUI's Ink 8 is ESM-only. The CJS
// dependencies expect CommonJS's module scope — proper-lockfile `require()`s
// Node built-ins, write-file-atomic names its temp files after `__filename` —
// which an ESM module doesn't have, so the banner defines the three. Not
// minified: a stack trace from it should be readable.
// `react-devtools-core` is Ink's optional peer, only imported when DEV=true.
const isExternal = (id: string) =>
    id.startsWith('node:') || builtinModules.includes(id) || id === 'react-devtools-core';

export default defineConfig({
    // The TUI is React (Ink): JSX on the automatic runtime, as in the webview
    // build, and React's production build — Node has `process`, but nothing
    // sets NODE_ENV for a command-line tool, and React's development build is
    // the default without it.
    esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    // Resolve packages the way Node does. A lib build otherwise takes the
    // `browser` export condition and field, so Ink's chalk bundled its
    // browser colour detector, which reports no colour in Node, and the TUI
    // drew without a single style.
    resolve: { conditions: defaultServerConditions, mainFields: defaultServerMainFields },
    build: {
        lib: {
            entry: 'src/cli/bin.ts',
            formats: ['es'],
            fileName: () => 'tsk.mjs',
        },
        target: 'node22',
        outDir: 'dist/cli',
        sourcemap: true,
        emptyOutDir: true,
        minify: false,
        rollupOptions: {
            external: isExternal,
            output: {
                banner: [
                    "import { createRequire as __tskCreateRequire } from 'node:module';",
                    "import { dirname as __tskDirname } from 'node:path';",
                    "import { fileURLToPath as __tskFileURLToPath } from 'node:url';",
                    'const require = __tskCreateRequire(import.meta.url);',
                    'const __filename = __tskFileURLToPath(import.meta.url);',
                    'const __dirname = __tskDirname(__filename);',
                ].join('\n'),
            },
        },
    },
});
