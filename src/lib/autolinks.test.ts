import { describe, expect, it } from 'vitest';
import { type CompiledAutoLink, computeAutoLinkSpans, parseAutoLinkRules } from './autolinks';

/** Compile a single rule through the real parser, asserting it survived. */
function rule(pattern: string, target: string, flags?: string): CompiledAutoLink {
    const { rules, warnings } = parseAutoLinkRules([
        { pattern, target, ...(flags ? { flags } : {}) },
    ]);
    expect(warnings).toEqual([]);
    const [compiled] = rules;
    if (!compiled) throw new Error('rule() expected exactly one compiled rule');
    return compiled;
}

/** Just the substituted targets for a line, in resolved order. */
function targets(line: string, ...rules: CompiledAutoLink[]): string[] {
    return computeAutoLinkSpans(line, rules).map((s) => s.target);
}

describe('parseAutoLinkRules', () => {
    it('compiles a valid rule into a global + non-global pair', () => {
        const { rules, warnings } = parseAutoLinkRules([
            { pattern: '([A-Z]+)-(\\d+)', target: 'https://x/$1-$2' },
        ]);
        expect(warnings).toEqual([]);
        expect(rules).toHaveLength(1);
        const [r] = rules;
        expect(r?.reAll.global).toBe(true);
        expect(r?.reExpand.global).toBe(false);
        expect(r?.target).toBe('https://x/$1-$2');
    });

    it('skips and warns on an invalid regex', () => {
        const { rules, warnings } = parseAutoLinkRules([{ pattern: '[', target: 'https://x' }]);
        expect(rules).toEqual([]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('tsk.autolinks[0]');
        expect(warnings[0]).toContain('invalid regex');
    });

    it('skips entries missing or empty pattern/target', () => {
        const { rules, warnings } = parseAutoLinkRules([
            { target: 'https://x' },
            { pattern: 'a' },
            { pattern: '', target: 'https://x' },
            { pattern: 'a', target: '' },
        ]);
        expect(rules).toEqual([]);
        expect(warnings).toHaveLength(4);
    });

    it('skips non-object entries', () => {
        const { rules, warnings } = parseAutoLinkRules(['nope', 42, null, ['a']]);
        expect(rules).toEqual([]);
        expect(warnings).toHaveLength(4);
    });

    it('warns when the whole value is not an array', () => {
        expect(parseAutoLinkRules({}).warnings).toHaveLength(1);
        expect(parseAutoLinkRules('x').warnings).toHaveLength(1);
    });

    it('treats absent config as empty without warning', () => {
        expect(parseAutoLinkRules(undefined)).toEqual({ rules: [], warnings: [] });
        expect(parseAutoLinkRules(null)).toEqual({ rules: [], warnings: [] });
        expect(parseAutoLinkRules([])).toEqual({ rules: [], warnings: [] });
    });

    describe('flags', () => {
        it('accepts i/m/s/u and forces g onto reAll only', () => {
            const r = rule('abc', 'x', 'i');
            expect(r.reAll.flags).toBe('gi');
            expect(r.reExpand.flags).toBe('i');
        });

        it('strips a redundant user-supplied g', () => {
            const { rules, warnings } = parseAutoLinkRules([
                { pattern: 'a', target: 'x', flags: 'gi' },
            ]);
            expect(warnings).toEqual([]);
            expect(rules[0]?.reExpand.flags).toBe('i');
        });

        it('skips and warns on a disallowed flag', () => {
            const { rules, warnings } = parseAutoLinkRules([
                { pattern: 'a', target: 'x', flags: 'y' },
            ]);
            expect(rules).toEqual([]);
            expect(warnings[0]).toContain('flags');
        });

        it('skips on a duplicate flag', () => {
            expect(parseAutoLinkRules([{ pattern: 'a', target: 'x', flags: 'ii' }]).rules).toEqual(
                [],
            );
        });

        it('skips on a non-string flags field', () => {
            expect(parseAutoLinkRules([{ pattern: 'a', target: 'x', flags: 5 }]).rules).toEqual([]);
        });
    });
});

describe('computeAutoLinkSpans — substitution', () => {
    it('substitutes numbered groups', () => {
        expect(targets('JIRAID-123', rule('([A-Z]+)-(\\d+)', 'https://x/$1-$2'))).toEqual([
            'https://x/JIRAID-123',
        ]);
    });

    it('substitutes named groups via $<name>', () => {
        expect(
            targets('JIRAID-123', rule('(?<k>[A-Z]+)-(?<n>\\d+)', 'https://x/$<k>/$<n>')),
        ).toEqual(['https://x/JIRAID/123']);
    });

    it('supports $& (whole match) and $$ (literal dollar)', () => {
        expect(targets('AB-1', rule('[A-Z]+-\\d+', 'go/$&?cost=$$5'))).toEqual(['go/AB-1?cost=$5']);
    });

    it('renders an unmatched optional group as empty', () => {
        expect(targets('a', rule('(a)(b)?', '/$1$2'))).toEqual(['/a']);
    });
});

describe('computeAutoLinkSpans — spans & overlap', () => {
    it('returns the match range (0-based, end-exclusive)', () => {
        expect(computeAutoLinkSpans('see AB-1 now', [rule('[A-Z]+-\\d+', 'u/$&')])).toEqual([
            { startCol: 4, endCol: 8, target: 'u/AB-1' },
        ]);
    });

    it('links every match on a line', () => {
        expect(targets('AB-1 and CD-2', rule('([A-Z]+)-(\\d+)', 'u/$1$2'))).toEqual([
            'u/AB1',
            'u/CD2',
        ]);
    });

    it('applies multiple rules, sorted left-to-right', () => {
        const jira = rule('[A-Z]+-\\d+', 'jira/$&');
        const sha = rule('\\b[0-9a-f]{7}\\b', 'gh/$&');
        expect(targets('fix AB-12 in a1b2c3d', jira, sha)).toEqual(['jira/AB-12', 'gh/a1b2c3d']);
    });

    it('drops a later-rule span overlapping an earlier one (earlier rule wins)', () => {
        const wide = rule('[A-Z]+-\\d+', 'wide/$&');
        const narrow = rule('\\d+', 'narrow/$&');
        // wide → "AB-12" [0,5); narrow → "12" [3,5) overlaps, so it is dropped.
        expect(computeAutoLinkSpans('AB-12', [wide, narrow])).toEqual([
            { startCol: 0, endCol: 5, target: 'wide/AB-12' },
        ]);
    });

    it('returns nothing when no rule matches', () => {
        expect(computeAutoLinkSpans('plain text', [rule('\\d+', 'u/$&')])).toEqual([]);
    });

    it('skips zero-width matches (empty-matching pattern)', () => {
        expect(computeAutoLinkSpans('abc', [rule('x*', 'u/$&')])).toEqual([]);
    });
});

describe('computeAutoLinkSpans — look-around caveat', () => {
    it('keeps the range but no-ops the URL for a look-behind (documented)', () => {
        // Re-matching "7" in isolation drops the (?<=PROJ-) context, so the $1
        // substitution no-ops to the raw match — the range is still correct.
        expect(computeAutoLinkSpans('PROJ-7', [rule('(?<=PROJ-)(\\d+)', 'https://x/$1')])).toEqual([
            { startCol: 5, endCol: 6, target: '7' },
        ]);
    });
});
