import { fileURLToPath } from 'node:url';
import { build, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';

/**
 * The `tsk` bundle runs in Node, so each package in it must be the package's
 * Node build. A browser build can pass every unit test (vitest resolves for
 * Node) and still break the command: chalk's browser colour detector reports
 * no colour, and the TUI drew without a single style.
 */

const CONFIG = fileURLToPath(new URL('../../vite.config.cli.ts', import.meta.url));

async function bundledModules(): Promise<string[]> {
    const result = await build({ configFile: CONFIG, logLevel: 'silent', build: { write: false } });
    const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
    return outputs.flatMap((o) => o.output.flatMap((c) => (c.type === 'chunk' ? c.moduleIds : [])));
}

describe('the CLI bundle', () => {
    it('takes each package’s Node build, not its browser build', async () => {
        const modules = await bundledModules();
        expect(
            modules.some((m) => m.endsWith('/chalk/source/vendor/supports-color/index.js')),
        ).toBe(true);
        expect(modules.filter((m) => /node_modules\/.*browser/.test(m))).toEqual([]);
    }, 60_000);
});
