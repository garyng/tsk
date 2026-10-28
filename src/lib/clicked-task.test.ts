import { describe, expect, it } from 'vitest';
import { clickedTaskId, taskIdFromLink } from './clicked-task';

describe('clickedTaskId', () => {
    const line = 'see tsk:5tdnqp74, then tsk:m3task1.';

    it('is the tsk:<id> the column falls in, from its first column to its last', () => {
        expect(clickedTaskId({ column: 4, line })).toBe('5tdnqp74');
        expect(clickedTaskId({ column: 15, line })).toBe('5tdnqp74');
        expect(clickedTaskId({ column: 30, line })).toBe('m3task1');
    });

    it('is undefined beside a ref, or on a line without one', () => {
        expect(clickedTaskId({ column: 3, line })).toBeUndefined();
        expect(clickedTaskId({ column: 16, line })).toBeUndefined();
        expect(clickedTaskId({ column: 0, line: 'nothing here' })).toBeUndefined();
    });

    it('counts a wide character before the ref as two columns', () => {
        // 任务 takes columns 0–3, the space 4, tsk:5tdnqp74 5–16.
        expect(clickedTaskId({ column: 4, line: '任务 tsk:5tdnqp74' })).toBeUndefined();
        expect(clickedTaskId({ column: 5, line: '任务 tsk:5tdnqp74' })).toBe('5tdnqp74');
        expect(clickedTaskId({ column: 16, line: '任务 tsk:5tdnqp74' })).toBe('5tdnqp74');
    });

    it("takes the id from the extension's link under the mouse, whatever the text", () => {
        expect(
            clickedTaskId({
                column: 0,
                line: '[/] 5tdnqp74 the plan',
                hyperlink: 'vscode://garyng.tsk/open?id=5tdnqp74',
            }),
        ).toBe('5tdnqp74');
    });

    it('reads the text under another link', () => {
        expect(clickedTaskId({ column: 4, line, hyperlink: 'https://example.com/tsk' })).toBe(
            '5tdnqp74',
        );
    });
});

describe('taskIdFromLink', () => {
    it("reads the id from the extension's /open link, in VS Code or Insiders", () => {
        expect(taskIdFromLink('vscode://garyng.tsk/open?id=5tdnqp74')).toBe('5tdnqp74');
        expect(taskIdFromLink('vscode-insiders://garyng.tsk/open?id=5tdnqp74')).toBe('5tdnqp74');
    });

    it("is undefined for another extension, another path, or what isn't a URL", () => {
        expect(taskIdFromLink('vscode://other.ext/open?id=5tdnqp74')).toBeUndefined();
        expect(taskIdFromLink('vscode://garyng.tsk/show?id=5tdnqp74')).toBeUndefined();
        expect(taskIdFromLink('not a url')).toBeUndefined();
    });
});
