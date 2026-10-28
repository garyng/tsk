import { describe, expect, it } from 'vitest';
import type { TaskRecord } from './db';
import { dependsOnMenu, sanitizeClipboardForId, taskToPickItem } from './picker-logic';

describe('sanitizeClipboardForId', () => {
    it('strips surrounding whitespace', () => {
        expect(sanitizeClipboardForId('  abc123  ')).toBe('abc123');
    });

    it('takes only the first whitespace-delimited token', () => {
        expect(sanitizeClipboardForId('abc def')).toBe('abc');
    });

    it('handles newlines and tabs as token separators', () => {
        expect(sanitizeClipboardForId('id123\ntrailing')).toBe('id123');
        expect(sanitizeClipboardForId('  id123\t junk  ')).toBe('id123');
    });

    it('returns empty string for empty / whitespace-only input', () => {
        expect(sanitizeClipboardForId('')).toBe('');
        expect(sanitizeClipboardForId('   \n\t  ')).toBe('');
    });
});

describe('taskToPickItem', () => {
    const baseRecord: TaskRecord = {
        id: 'abc123',
        fileUri: 'file:///workspace/foo.tsk',
        line: 4,
        marker: 'todo',
        content: 'write the spec',
        raw: '- [ ] write the spec <!-- @id:abc123 -->',
    };

    it('maps content / id / file+line into the QuickPick shape', () => {
        expect(taskToPickItem(baseRecord)).toEqual({
            label: 'write the spec',
            description: 'abc123',
            // 0-indexed line → 1-indexed display per VSCode's file:line convention.
            detail: 'file:///workspace/foo.tsk:5',
            id: 'abc123',
        });
    });

    it('substitutes "(no content)" when the task has no content', () => {
        const item = taskToPickItem({ ...baseRecord, content: '' });
        expect(item.label).toBe('(no content)');
    });

    it('substitutes "(no content)" when content is whitespace only', () => {
        const item = taskToPickItem({ ...baseRecord, content: '   ' });
        expect(item.label).toBe('(no content)');
    });
});

describe('dependsOnMenu', () => {
    const content = (id: string) => ({ a: 'book the venue', b: '' })[id];

    it('offers add, a remove per dependency named by its text, then remove all', () => {
        expect(dependsOnMenu(['a', 'b', 'gone'], content)).toEqual([
            { label: '$(add) Add another dependency…', choice: { kind: 'add' } },
            {
                label: '$(close) Remove a',
                description: 'book the venue',
                choice: { kind: 'remove', id: 'a' },
            },
            {
                label: '$(close) Remove b',
                description: '(no content)',
                choice: { kind: 'remove', id: 'b' },
            },
            {
                label: '$(close) Remove gone',
                description: '(missing)',
                choice: { kind: 'remove', id: 'gone' },
            },
            { label: '$(trash) Remove all dependencies', choice: { kind: 'removeAll' } },
        ]);
    });

    it('has no remove-all for a single dependency', () => {
        expect(dependsOnMenu(['a'], content).map((i) => i.choice.kind)).toEqual(['add', 'remove']);
    });
});
