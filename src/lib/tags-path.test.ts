import { describe, expect, it } from 'vitest';
import { resolveTagsPath } from './tags-path';

describe('resolveTagsPath', () => {
    it('returns undefined when there is no workspace folder', () => {
        expect(
            resolveTagsPath('${workspaceFolder}/.vscode/tsk/tags.yml', undefined),
        ).toBeUndefined();
        expect(resolveTagsPath('/abs/path/tags.yml', undefined)).toBeUndefined();
    });

    it('returns undefined for an empty or whitespace-only setting', () => {
        expect(resolveTagsPath('', '/home/user/proj')).toBeUndefined();
        expect(resolveTagsPath('   \t', '/home/user/proj')).toBeUndefined();
    });

    it('substitutes the ${workspaceFolder} placeholder', () => {
        expect(resolveTagsPath('${workspaceFolder}/.vscode/tsk/tags.yml', '/home/user/proj')).toBe(
            '/home/user/proj/.vscode/tsk/tags.yml',
        );
    });

    it('returns absolute paths verbatim', () => {
        expect(resolveTagsPath('/etc/tsk/tags.yml', '/home/user/proj')).toBe('/etc/tsk/tags.yml');
    });

    it('returns relative paths verbatim (caller decides how to anchor them)', () => {
        expect(resolveTagsPath('tags.yml', '/home/user/proj')).toBe('tags.yml');
    });
});
