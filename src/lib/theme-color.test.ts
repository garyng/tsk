import { describe, expect, it } from 'vitest';
import { themeColorVar } from './theme-color';

describe('themeColorVar', () => {
    it('replaces only the first dot, as VS Code names a webview’s theme variables, escaping the rest', () => {
        expect(themeColorVar('tsk.marker.completed')).toBe('--vscode-tsk-marker\\.completed');
        expect(themeColorVar('editor.foreground')).toBe('--vscode-editor-foreground');
        expect(themeColorVar('disabledForeground')).toBe('--vscode-disabledForeground');
    });
});
