import { describe, expect, it } from 'vitest';
import { resolveBridgePath } from './clipboard-bridge-path';

describe('resolveBridgePath', () => {
    it('returns undefined for an empty or whitespace setting', () => {
        expect(resolveBridgePath('', '/work')).toBeUndefined();
        expect(resolveBridgePath('   ', '/work')).toBeUndefined();
    });

    it('substitutes ${workspaceFolder} when a folder is present', () => {
        expect(resolveBridgePath('${workspaceFolder}/.vscode/tsk-clipboard.txt', '/work')).toBe(
            '/work/.vscode/tsk-clipboard.txt',
        );
    });

    it('returns undefined when the placeholder is used but no folder is open', () => {
        expect(
            resolveBridgePath('${workspaceFolder}/.vscode/tsk-clipboard.txt', undefined),
        ).toBeUndefined();
    });

    it('passes a placeholder-free absolute path through unchanged', () => {
        expect(resolveBridgePath('/tmp/tsk-clipboard.txt', '/work')).toBe('/tmp/tsk-clipboard.txt');
        // ...even with no workspace folder, since it needs no substitution.
        expect(resolveBridgePath('/tmp/tsk-clipboard.txt', undefined)).toBe(
            '/tmp/tsk-clipboard.txt',
        );
    });

    it('trims surrounding whitespace before resolving', () => {
        expect(resolveBridgePath('  /tmp/x.txt  ', '/work')).toBe('/tmp/x.txt');
    });

    it('replaces every occurrence of the placeholder (defensive)', () => {
        expect(resolveBridgePath('${workspaceFolder}/a/${workspaceFolder}.txt', '/w')).toBe(
            '/w/a//w.txt',
        );
    });
});
