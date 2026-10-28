import { describe, expect, it } from 'vitest';
import { filesGone, filesUnder } from './cached-files';

const cached = [
    'file:///w/claude.tsk',
    'file:///w/.claude/worktrees/agent-a5/claude.tsk',
    'file:///w/.claude/worktrees/agent-a5b/claude.tsk',
];

describe('filesGone', () => {
    it('names the cached files the listing no longer has', () => {
        expect(filesGone(cached, new Set(['file:///w/claude.tsk', 'file:///w/new.tsk']))).toEqual([
            'file:///w/.claude/worktrees/agent-a5/claude.tsk',
            'file:///w/.claude/worktrees/agent-a5b/claude.tsk',
        ]);
        expect(filesGone(cached, new Set(cached))).toEqual([]);
    });
});

describe('filesUnder', () => {
    it('names the cached files inside a folder, not ones in a folder whose name starts the same', () => {
        expect(filesUnder(cached, 'file:///w/.claude/worktrees/agent-a5')).toEqual([
            'file:///w/.claude/worktrees/agent-a5/claude.tsk',
        ]);
        expect(filesUnder(cached, 'file:///w/.claude/worktrees/')).toEqual(cached.slice(1));
    });

    it('names nothing for a file, or a folder holding none', () => {
        expect(filesUnder(cached, 'file:///w/claude.tsk')).toEqual([]);
        expect(filesUnder(cached, 'file:///elsewhere')).toEqual([]);
    });
});
