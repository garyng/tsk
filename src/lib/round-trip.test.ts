/**
 * Integration tests crossing `parser.ts` and `metadata.ts`. The two modules
 * already share `extractMetadata`, but the *serialized form* the serializer
 * emits and the *expected form* the parser accepts are separate code paths
 * (one writes the comment shell + entries; the other matches them). These
 * tests pin the agreement so future edits to either can't drift silently.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from './ids';
import { replaceMetadata, serializeMetadata } from './metadata';
import { parseLine } from './parser';

describe('round-trip — parse → replaceMetadata(no-op) → parse', () => {
    const corpus: Array<[label: string, line: string]> = [
        ['plain task', '- [x] plain task'],
        ['single metadata entry', '- [ ] todo <!-- @id:abc12345 -->'],
        ['multiple metadata entries', '- [x] do <!-- @a:1 @b:2 @c:3 -->'],
        [
            'lifecycle metadata',
            '- [/] in progress <!-- @id:k3w8t9rx @created:2026-05-24T15:00:30+08:00 @started:2026-05-24T15:30:00+08:00 -->',
        ],
        ['null-valued flag', '- [n] note <!-- @flag @id:x -->'],
        ['empty-string flag', '- [x] done <!-- @flag: -->'],
        ['flag and value side by side', '- [x] do <!-- @flag @id:abc -->'],
        ['hierarchical tags', '- [x] tagged #project/test/sub #JIRAID-123'],
        ['mixed inline tag and metadata', '- [x] mixed #tag <!-- @id:abc -->'],
        ['indented task', '    - [x] indented <!-- @id:abc -->'],
        ['relationship metadata', '- [ ] child <!-- @id:c @parent:p @dependsOn:d -->'],
    ];

    for (const [label, line] of corpus) {
        it(`preserves all parsed fields for ${label}`, () => {
            const first = parseLine(line);
            expect(first).not.toBeNull();

            const rewritten = replaceMetadata(line, () => {});
            const second = parseLine(rewritten);
            expect(second).not.toBeNull();

            expect(second?.marker).toBe(first?.marker);
            expect(second?.indent).toBe(first?.indent);
            expect(second?.tags).toEqual(first?.tags);
            expect([...(second?.metadata ?? [])]).toEqual([...(first?.metadata ?? [])]);
        });
    }
});

describe('round-trip — serializeMetadata → parseLine', () => {
    /**
     * Property-style: generate metadata Maps from a fixed corpus of keys and
     * value shapes, serialize them, parse the resulting line, and assert
     * round-trip equality. Seeded RNG → reproducible.
     */
    it('serialize → parse preserves arbitrary metadata combinations', () => {
        const rng = mulberry32(42);
        const keys = [
            'id',
            'created',
            'started',
            'completed',
            'cancelled',
            'parent',
            'movedTo',
            'dependsOn',
            'relatedTo',
            'priority',
            'flag',
        ];
        const values: Array<string | null> = [
            'abc12345',
            'k3w8t9rx',
            '2026-05-24T15:00:30+08:00',
            '2026-01-02T09:15:42-05:00',
            '1',
            '2',
            '3',
            'true',
            null,
            '',
        ];

        function pick<T>(arr: T[]): T {
            return arr[Math.floor(rng() * arr.length)] as T;
        }

        for (let trial = 0; trial < 100; trial++) {
            const map = new Map<string, string | null>();
            const numKeys = Math.floor(rng() * 5) + 1;
            const used = new Set<string>();
            for (let i = 0; i < numKeys; i++) {
                let key = pick(keys);
                // avoid duplicate keys in the same line so the comparison is
                // straightforward (duplicate-key semantics are tested elsewhere).
                while (used.has(key)) key = pick(keys);
                used.add(key);
                map.set(key, pick(values));
            }

            const serialized = serializeMetadata(map);
            const line = `- [x] task ${serialized}`;
            const parsed = parseLine(line);

            expect(parsed, `trial ${trial}: ${line}`).not.toBeNull();
            expect([...(parsed?.metadata ?? [])], `trial ${trial}: ${line}`).toEqual([...map]);
        }
    });
});

describe('docs/demo.tsk — every task-shaped line parses cleanly', () => {
    // Reads the live demo file so new tasks added by future milestones are
    // covered automatically. If a feature change breaks the demo file, this
    // test surfaces it — per `apps/tsk/CLAUDE.md`, demo.tsk is a regression
    // artefact, not just documentation.
    const demoPath = resolve(__dirname, '../../docs/demo.tsk');
    const text = readFileSync(demoPath, 'utf-8');
    const taskLines = text.split(/\r?\n/).filter((l) => /^\s*[-*+]\s+\[/.test(l));

    it('finds at least one task-shaped line in the demo file', () => {
        expect(taskLines.length).toBeGreaterThan(0);
    });

    for (const line of taskLines) {
        const label = line.slice(0, 60) + (line.length > 60 ? '…' : '');
        it(`parses: ${label}`, () => {
            expect(parseLine(line), `failed on line: ${line}`).not.toBeNull();
        });
    }
});
