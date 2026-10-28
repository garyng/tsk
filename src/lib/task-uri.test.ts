import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTENSION_ID, openTaskUri, taskIdFromInput, taskIdFromUri } from './task-uri';

const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));

describe('taskIdFromUri', () => {
    it('reads the id from /open?id=<id>', () => {
        expect(taskIdFromUri('/open', 'id=5tdnqp74')).toBe('5tdnqp74');
    });

    it('takes a tsk:<id> as the id too', () => {
        expect(taskIdFromUri('/open', 'id=tsk%3A5tdnqp74')).toBe('5tdnqp74');
    });

    it('ignores other parameters', () => {
        expect(taskIdFromUri('/open', 'from=tmux&id=5tdnqp74')).toBe('5tdnqp74');
    });

    it('is undefined for another path, or without an id', () => {
        expect(taskIdFromUri('/show', 'id=5tdnqp74')).toBeUndefined();
        expect(taskIdFromUri('/open', '')).toBeUndefined();
        expect(taskIdFromUri('/open', 'id=')).toBeUndefined();
    });

    it("is undefined for an id that couldn't be an @id", () => {
        expect(taskIdFromUri('/open', 'id=two%20words')).toBeUndefined();
        expect(taskIdFromUri('/open', 'id=a--%3E')).toBeUndefined();
    });
});

describe('taskIdFromInput', () => {
    it('trims what was typed', () => {
        expect(taskIdFromInput('  5tdnqp74 ')).toBe('5tdnqp74');
    });

    it('drops a tsk: or @id: prefix, as a plan or a .tsk file writes the id', () => {
        expect(taskIdFromInput('tsk:5tdnqp74')).toBe('5tdnqp74');
        expect(taskIdFromInput('@id:5tdnqp74')).toBe('5tdnqp74');
    });

    it('keeps ids that are not the generator’s shape, as a hand-written @id may be', () => {
        expect(taskIdFromInput('m3task1')).toBe('m3task1');
        expect(taskIdFromInput('e2e-graph-parent')).toBe('e2e-graph-parent');
    });

    it('is undefined for nothing, or for more than one word', () => {
        expect(taskIdFromInput('')).toBeUndefined();
        expect(taskIdFromInput('tsk:')).toBeUndefined();
        expect(taskIdFromInput('two words')).toBeUndefined();
    });
});

describe('EXTENSION_ID', () => {
    it("is the package's publisher and name, as VS Code names the extension", () => {
        expect(EXTENSION_ID).toBe(`${pkg.publisher}.${pkg.name}`);
    });
});

describe('openTaskUri', () => {
    it('is the URI the handler reads the id back from', () => {
        const uri = new URL(openTaskUri('vscode-insiders', 'garyng.tsk', 'my_task-2'));
        expect(uri.href).toBe('vscode-insiders://garyng.tsk/open?id=my_task-2');
        expect(taskIdFromUri(uri.pathname, uri.search.slice(1))).toBe('my_task-2');
    });
});
