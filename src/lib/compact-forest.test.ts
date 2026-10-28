import { describe, expect, it } from 'vitest';
import { compactForest } from './compact-forest';

interface N {
    name: string;
    kids?: N[];
}
const children = (n: N) => n.kids ?? [];
const rows = (roots: N[]) =>
    compactForest(roots, children).map(
        (r) => `${r.depth}${r.chained ? '↳' : ' '}${r.isFork ? '*' : ' '}${r.node.name}`,
    );

describe('compactForest', () => {
    it('keeps a chain of only children at one depth, marking each link', () => {
        const chain: N = {
            name: 'a',
            kids: [{ name: 'b', kids: [{ name: 'c', kids: [{ name: 'd' }] }] }],
        };
        expect(rows([chain])).toEqual(['0  a', '0↳ b', '0↳ c', '0↳ d']);
    });

    it('indents only at a fork, and a chain inside a branch stays at the branch depth', () => {
        const tree: N = {
            name: 'plan',
            kids: [
                { name: 'p0' },
                { name: 'p1', kids: [{ name: 'side', kids: [{ name: 'deeper' }] }] },
            ],
        };
        expect(rows([tree])).toEqual(['0 *plan', '1  p0', '1  p1', '1↳ side', '1↳ deeper']);
    });

    it('lays out several roots in order', () => {
        expect(rows([{ name: 'r1' }, { name: 'r2', kids: [{ name: 'k' }] }])).toEqual([
            '0  r1',
            '0  r2',
            '0↳ k',
        ]);
    });
});
