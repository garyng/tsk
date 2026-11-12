import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureCacheParentDir, IN_MEMORY, resolveCachePath } from './cache-path';

describe('resolveCachePath', () => {
    const none = { workspaceFolder: undefined, workspaceStorage: undefined };
    const at = (workspaceFolder: string) => ({
        workspaceFolder,
        workspaceStorage: '/store/ws1/garyng.tsk',
    });

    it('returns :memory: when no workspace folder is open', () => {
        expect(resolveCachePath('${workspaceFolder}/.vscode/tsk-cache.db', none)).toBe(IN_MEMORY);
    });

    it('returns :memory: when the raw setting is empty (even with a workspace folder)', () => {
        expect(resolveCachePath('', at('/repo'))).toBe(IN_MEMORY);
    });

    it('returns :memory: when the raw setting is whitespace', () => {
        expect(resolveCachePath('   ', at('/repo'))).toBe(IN_MEMORY);
    });

    it('expands ${workspaceFolder} into the actual folder path', () => {
        expect(
            resolveCachePath('${workspaceFolder}/.vscode/tsk-cache.db', at('/home/me/repo')),
        ).toBe('/home/me/repo/.vscode/tsk-cache.db');
    });

    it("expands ${workspaceStorage} into the extension's storage for the workspace", () => {
        expect(resolveCachePath('${workspaceStorage}/state.db', at('/repo'))).toBe(
            '/store/ws1/garyng.tsk/state.db',
        );
        expect(
            resolveCachePath('${workspaceStorage}/state.db', {
                workspaceFolder: '/repo',
                workspaceStorage: undefined,
            }),
        ).toBe(IN_MEMORY);
    });

    it('passes through an absolute path without a placeholder unchanged', () => {
        expect(resolveCachePath('/var/cache/tsk.db', at('/home/me/repo'))).toBe(
            '/var/cache/tsk.db',
        );
    });

    it('trims surrounding whitespace from the setting', () => {
        expect(resolveCachePath('  /var/cache/tsk.db  ', at('/repo'))).toBe('/var/cache/tsk.db');
    });

    it('only substitutes the first occurrence of the placeholder', () => {
        // Intentional — multiple substitutions in one setting value are not
        // a real-world case; the simpler `String.prototype.replace` semantic
        // is fine.
        expect(resolveCachePath('${workspaceFolder}/a/${workspaceFolder}/b', at('/repo'))).toBe(
            '/repo/a/${workspaceFolder}/b',
        );
    });
});

describe('ensureCacheParentDir', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), 'tsk-path-test-'));
    });

    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('is a no-op for :memory:', () => {
        // Should not throw, and should not create any directories.
        expect(() => ensureCacheParentDir(IN_MEMORY)).not.toThrow();
    });

    it('creates a missing parent directory recursively', () => {
        const path = join(tmp, 'nested', 'dirs', 'cache.db');
        ensureCacheParentDir(path);
        expect(existsSync(dirname(path))).toBe(true);
    });

    it('is idempotent — calling twice on the same path is fine', () => {
        const path = join(tmp, 'cache.db');
        ensureCacheParentDir(path);
        expect(() => ensureCacheParentDir(path)).not.toThrow();
    });
});
