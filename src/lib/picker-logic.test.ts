import { describe, expect, it } from 'vitest';
import type { TaskRecord } from './db';
import { sanitizeClipboardForId, taskToPickItem } from './picker-logic';

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
