import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { descendants, processTree } from './process-tree';

describe('descendants', () => {
    it('is the root and everything under it, however deep, and nothing beside it', () => {
        const parentOf = new Map([
            [2, 1],
            [3, 2],
            [4, 3],
            [5, 1],
            [6, 9],
        ]);
        expect(descendants(2, parentOf)).toEqual(new Set([2, 3, 4]));
        expect(descendants(1, parentOf)).toEqual(new Set([1, 2, 3, 4, 5]));
        expect(descendants(4, parentOf)).toEqual(new Set([4]));
    });
});

describe('processTree', () => {
    it('finds a grandchild of this process', async () => {
        const child = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], {
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        try {
            const grandchild = await new Promise<number>((resolve) =>
                child.stdout.once('data', (d: Buffer) => resolve(Number(String(d).trim()))),
            );
            const tree = processTree(process.pid);
            expect(tree.has(child.pid as number)).toBe(true);
            expect(tree.has(grandchild)).toBe(true);
            expect(processTree(child.pid as number).has(process.pid)).toBe(false);
            process.kill(grandchild);
        } finally {
            child.kill();
        }
    });
});
