import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKER_SYMBOL_CHAR_CLASS, MARKERS, markerForSymbol } from './markers';

/**
 * Drift detection: `MARKERS` is the TS source of truth, but VSCode reads
 * `package.json` and `syntaxes/tsk.tmLanguage.json` directly. These tests
 * fail the build if the two JSON files ever diverge from the registry —
 * e.g. someone renames a marker in TS but forgets to update the grammar.
 */

const REPO_ROOT = resolve(__dirname, '../..');
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, 'package.json');
const GRAMMAR_PATH = resolve(REPO_ROOT, 'syntaxes/tsk.tmLanguage.json');

interface PackageColor {
    id: string;
    description: string;
    defaults: { light: string; dark: string };
}

describe('MARKERS shape', () => {
    it('every marker has a non-empty symbols list', () => {
        for (const def of MARKERS) {
            expect(def.symbols.length).toBeGreaterThan(0);
        }
    });

    it('symbols across all markers are distinct (no duplicate routing)', () => {
        const all = MARKERS.flatMap((m) => [...m.symbols]);
        expect(new Set(all).size).toBe(all.length);
    });

    it('canonical (first) symbol of each marker is unique', () => {
        const firsts = MARKERS.map((m) => m.symbols[0]);
        expect(new Set(firsts).size).toBe(firsts.length);
    });

    it('every marker name is lowercase', () => {
        for (const def of MARKERS) {
            expect(def.name).toBe(def.name.toLowerCase());
        }
    });
});

describe('markerForSymbol', () => {
    it('round-trips each canonical and alias symbol back to its marker', () => {
        for (const def of MARKERS) {
            for (const symbol of def.symbols) {
                expect(markerForSymbol(symbol)).toBe(def.name);
            }
        }
    });

    it('returns undefined for an unknown symbol', () => {
        expect(markerForSymbol('?')).toBeUndefined();
        expect(markerForSymbol('')).toBeUndefined();
    });
});

describe('MARKER_SYMBOL_CHAR_CLASS', () => {
    it('contains every accepted symbol', () => {
        for (const def of MARKERS) {
            for (const symbol of def.symbols) {
                // The class string is the raw join (with regex-special chars
                // escaped); a literal symbol char will still appear in it.
                expect(MARKER_SYMBOL_CHAR_CLASS).toContain(symbol);
            }
        }
    });

    it('produces a regex that matches exactly the registry symbols', () => {
        const re = new RegExp(`^[${MARKER_SYMBOL_CHAR_CLASS}]$`);
        for (const def of MARKERS) {
            for (const symbol of def.symbols) {
                expect(re.test(symbol)).toBe(true);
            }
        }
        for (const reject of ['?', 'a', 'z', '0', '\t']) {
            expect(re.test(reject)).toBe(false);
        }
    });
});

describe('drift — package.json contributes.colors mirrors MARKERS', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
    const pkgColors = (pkg.contributes?.colors ?? []) as PackageColor[];

    it('one entry in package.json for every MARKER with a color', () => {
        const expected = MARKERS.flatMap((m) => (m.color ? [m.color.id] : []));
        expect(pkgColors.map((c) => c.id)).toEqual(expected);
    });

    it('each MARKER.color matches the package.json entry exactly', () => {
        for (const def of MARKERS) {
            const color = def.color;
            if (!color) continue;
            const entry = pkgColors.find((c) => c.id === color.id);
            expect(entry, `expected colors entry for ${color.id}`).toBeDefined();
            expect(entry).toEqual({
                id: color.id,
                description: color.description,
                defaults: { light: color.light, dark: color.dark },
            });
        }
    });

    it('package.json does not declare colors outside the MARKERS registry', () => {
        const registryIds = new Set<string>(MARKERS.flatMap((m) => (m.color ? [m.color.id] : [])));
        for (const entry of pkgColors) {
            expect(registryIds.has(entry.id), `stray color id ${entry.id} in package.json`).toBe(
                true,
            );
        }
    });
});

describe('drift — tsk.tmLanguage.json mentions every MARKER scope', () => {
    const grammarText = readFileSync(GRAMMAR_PATH, 'utf-8');

    it('every MARKER scopeName appears in the grammar source', () => {
        for (const def of MARKERS) {
            expect(
                grammarText.includes(def.scopeName),
                `grammar is missing scope ${def.scopeName}`,
            ).toBe(true);
        }
    });
});
