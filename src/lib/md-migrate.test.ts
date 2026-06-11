import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MARKERS } from './markers';
import {
    DEFAULT_MD_MARKER_MAP,
    type MdStamps,
    matchMdTask,
    migrateMdLine,
    stampKeyForMarker,
    validateMarkerMap,
} from './md-migrate';
import { parseLine } from './parser';

/** The validated default map (the owner's vocabulary). */
const MAP = validateMarkerMap(DEFAULT_MD_MARKER_MAP);

const STAMPS: MdStamps = {
    created: '2026-03-01T10:00:00+08:00',
    status: '2026-04-02T18:30:00+08:00',
};

describe('package.json drift gates (tsk.migrate.markers)', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8')) as {
        contributes: {
            configuration: {
                properties: Record<
                    string,
                    { default?: unknown; additionalProperties?: { enum?: string[] } }
                >;
            };
        };
    };
    const setting = pkg.contributes.configuration.properties['tsk.migrate.markers'];

    it('the manifest default mirrors DEFAULT_MD_MARKER_MAP', () => {
        expect(setting?.default).toEqual(DEFAULT_MD_MARKER_MAP);
    });

    it('the manifest enum mirrors the MARKERS registry names', () => {
        expect(setting?.additionalProperties?.enum).toEqual(MARKERS.map((m) => m.name));
    });
});

describe('validateMarkerMap', () => {
    it('accepts the default map verbatim', () => {
        expect([...MAP.entries()]).toEqual([
            [' ', 'todo'],
            ['/', 'completed'],
            ['>>', 'moved'],
            ['x', 'cancelled'],
            ['n', 'notes'],
        ]);
    });

    it('drops an unknown status name and warns', () => {
        const warn = vi.fn();
        const map = validateMarkerMap({ x: 'done', ' ': 'todo' }, warn);
        expect([...map.keys()]).toEqual([' ']);
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0]?.[0]).toContain('done');
    });

    it('drops an empty glyph and a glyph containing "]" — both break the bracket parse', () => {
        const warn = vi.fn();
        const map = validateMarkerMap({ '': 'todo', 'a]b': 'todo', ok: 'todo' }, warn);
        expect([...map.keys()]).toEqual(['ok']);
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it('yields an empty map (with a warning) for a non-object', () => {
        const warn = vi.fn();
        for (const raw of [42, 'x', null, ['x']]) {
            expect(validateMarkerMap(raw, warn).size).toBe(0);
        }
        expect(warn).toHaveBeenCalledTimes(4);
    });

    it('does not require a warn callback', () => {
        expect(() => validateMarkerMap(42)).not.toThrow();
    });
});

describe('matchMdTask', () => {
    it.each([
        ['- [ ] water the plants', ' ', 'water the plants'],
        ['- [/] ship the redesign', '/', 'ship the redesign'],
        ['- [>>] file taxes', '>>', 'file taxes'],
        ['- [x] dark mode', 'x', 'dark mode'],
        ['- [n] hose adapter is 13mm', 'n', 'hose adapter is 13mm'],
    ])('matches every default-map glyph: %s', (line, glyph, content) => {
        expect(matchMdTask(line, MAP)).toMatchObject({ glyph, content });
    });

    it('captures indent and bullet verbatim (nested, * and + bullets, tabs)', () => {
        expect(matchMdTask('    - [x] nested', MAP)).toMatchObject({
            indent: '    ',
            bullet: '- ',
        });
        expect(matchMdTask('* [ ] star', MAP)).toMatchObject({ bullet: '* ' });
        expect(matchMdTask('+   [n] plus, wide', MAP)).toMatchObject({ bullet: '+   ' });
        expect(matchMdTask('\t- [/] tabbed', MAP)).toMatchObject({ indent: '\t' });
    });

    it.each([
        ['plain prose', null],
        ['- bare bullet', null],
        ['## heading', null],
        ['- [q] unmapped glyph', null],
        ['- [!] tsk glyph not in the md map', null],
        ['- [x](https://example.com) a LINK, not a task', null],
        ['- [ ](url) link with space-glyph text', null],
    ])('returns null for %s', (line) => {
        expect(matchMdTask(line, MAP)).toBeNull();
    });

    it('matches an empty-content task and trims trailing whitespace + stray \\r', () => {
        expect(matchMdTask('- [/]', MAP)).toMatchObject({ glyph: '/', content: '' });
        expect(matchMdTask('- [/]   ', MAP)).toMatchObject({ content: '' });
        expect(matchMdTask('- [x] done  \r', MAP)).toMatchObject({ content: 'done' });
    });

    it('prefers the longest glyph at a fork (">>" wins over a ">" entry)', () => {
        const map = validateMarkerMap({ '>': 'moved', '>>': 'moved' });
        expect(matchMdTask('- [>>] both defined', map)?.glyph).toBe('>>');
    });

    it('matches nothing under an empty map', () => {
        expect(matchMdTask('- [x] anything', new Map())).toBeNull();
    });
});

describe('stampKeyForMarker', () => {
    it('maps the status-bearing markers and leaves todo/notes unstamped', () => {
        expect(stampKeyForMarker('completed')).toBe('completed');
        expect(stampKeyForMarker('cancelled')).toBe('cancelled');
        expect(stampKeyForMarker('moved')).toBe('moved');
        expect(stampKeyForMarker('inprogress')).toBe('started');
        expect(stampKeyForMarker('todo')).toBeUndefined();
        expect(stampKeyForMarker('notes')).toBeUndefined();
    });
});

describe('migrateMdLine', () => {
    it('md todo → tsk [ ] with @id + @created only', () => {
        expect(migrateMdLine('- [ ] water the plants', MAP, STAMPS, 'id1')).toBe(
            '- [ ] water the plants <!-- @id:id1 @created:2026-03-01T10:00:00+08:00 -->',
        );
    });

    it('md done [/] → tsk [x] with @completed (the glyph collision, remapped)', () => {
        expect(migrateMdLine('- [/] ship it', MAP, STAMPS, 'id2')).toBe(
            '- [x] ship it <!-- @id:id2 @created:2026-03-01T10:00:00+08:00 @completed:2026-04-02T18:30:00+08:00 -->',
        );
    });

    it('md cancelled [x] → tsk [!] with @cancelled (the other collision)', () => {
        expect(migrateMdLine('- [x] dark mode', MAP, STAMPS, 'id3')).toBe(
            '- [!] dark mode <!-- @id:id3 @created:2026-03-01T10:00:00+08:00 @cancelled:2026-04-02T18:30:00+08:00 -->',
        );
    });

    it('md moved [>>] → tsk [>] with @moved and NO @movedTo', () => {
        const out = migrateMdLine('- [>>] file taxes', MAP, STAMPS, 'id4');
        expect(out).toBe(
            '- [>] file taxes <!-- @id:id4 @created:2026-03-01T10:00:00+08:00 @moved:2026-04-02T18:30:00+08:00 -->',
        );
        expect(out).not.toContain('@movedTo');
    });

    it('md note [n] → tsk [n] with @id + @created only (status stamp ignored)', () => {
        expect(migrateMdLine('- [n] hose is 13mm', MAP, STAMPS, 'id5')).toBe(
            '- [n] hose is 13mm <!-- @id:id5 @created:2026-03-01T10:00:00+08:00 -->',
        );
    });

    it('a glyph mapped to inprogress stamps @started (custom GFM-style map)', () => {
        const gfm = validateMarkerMap({ '/': 'inprogress' });
        expect(migrateMdLine('- [/] underway', gfm, STAMPS, 'id6')).toBe(
            '- [/] underway <!-- @id:id6 @created:2026-03-01T10:00:00+08:00 @started:2026-04-02T18:30:00+08:00 -->',
        );
    });

    it('omits the status stamp when no value was derived', () => {
        expect(migrateMdLine('- [/] done, no git date', MAP, { created: 'c1' }, 'id7')).toBe(
            '- [x] done, no git date <!-- @id:id7 @created:c1 -->',
        );
    });

    it('skips a line already carrying @id (idempotent re-run) and non-task lines', () => {
        expect(migrateMdLine('- [/] already tsk <!-- @id:abc -->', MAP, STAMPS, 'id8')).toBeNull();
        expect(migrateMdLine('plain prose', MAP, STAMPS, 'id9')).toBeNull();
        expect(migrateMdLine('- bare bullet', MAP, STAMPS, 'id10')).toBeNull();
    });

    it('preserves indent, bullet style, and rich content verbatim', () => {
        expect(
            migrateMdLine('    * [/] **bold** [link](https://x.y) #tag/sub', MAP, STAMPS, 'id11'),
        ).toBe(
            '    * [x] **bold** [link](https://x.y) #tag/sub <!-- @id:id11 @created:2026-03-01T10:00:00+08:00 @completed:2026-04-02T18:30:00+08:00 -->',
        );
    });

    it('writes the empty-content two-space shape the toggle mutators also use', () => {
        expect(migrateMdLine('- [ ]', MAP, { created: 'c1' }, 'id12')).toBe(
            '- [ ]  <!-- @id:id12 @created:c1 -->',
        );
    });

    it('every migrated line round-trips through the tsk parser with the mapped marker', () => {
        const cases: Array<[string, string]> = [
            ['- [ ] a', 'todo'],
            ['- [/] b', 'completed'],
            ['- [>>] c', 'moved'],
            ['- [x] d', 'cancelled'],
            ['- [n] e', 'notes'],
        ];
        for (const [line, marker] of cases) {
            const migrated = migrateMdLine(line, MAP, STAMPS, 'rt');
            expect(migrated).not.toBeNull();
            const parsed = parseLine(migrated as string);
            expect(parsed?.marker).toBe(marker);
            expect(parsed?.metadata.get('id')).toBe('rt');
        }
    });
});
