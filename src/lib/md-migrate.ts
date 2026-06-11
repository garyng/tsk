/**
 * Pure core of the Markdown→tsk migration: match task lines written in a
 * user-configurable *markdown* marker vocabulary, and rewrite them as tsk
 * tasks (remapped marker + a fresh `<!-- @id @created [@stamp] -->` comment).
 *
 * The md vocabulary reuses tsk glyphs with DIFFERENT meanings (the default
 * map reads `[/]` as *done* and `[x]` as *cancelled*, where tsk means
 * in-progress / completed), so the remap is semantic, not textual. The one
 * disambiguation rule that keeps re-runs safe: migration only ever touches
 * lines WITHOUT `@id` metadata, and every migrated line gains one — so an
 * id-less line always speaks the md vocabulary, an id-carrying line is
 * already tsk, and a half-migrated file re-runs as a no-op.
 *
 * Pure — no I/O, no vscode. Timestamps and ids are caller-supplied (derived
 * from git history by `md-git-history.ts`, or `localTimestamp()` fallbacks).
 */

import { GLYPH, MARKERS, type Marker } from './markers';
import { extractMetadata, serializeMetadata } from './metadata';
import { parseLine } from './parser';
import { STATE_TIMESTAMP_KEY } from './toggle-mutators';

/**
 * The default md glyph → tsk status mapping — the owner's vocabulary. GFM
 * users override per-glyph via the `tsk.migrate.markers` setting (e.g.
 * `{"x": "completed", "/": "inprogress"}`).
 */
export const DEFAULT_MD_MARKER_MAP: Readonly<Record<string, Marker>> = {
    ' ': 'todo',
    '/': 'completed',
    '>>': 'moved',
    x: 'cancelled',
    n: 'notes',
};

/**
 * Status → the timestamp key its migration stamps (beyond `@created`).
 * Derives from {@link STATE_TIMESTAMP_KEY} (the toggles' own pairing) plus
 * `moved` (whose `@moved` stamp lives on the move path, not the state
 * toggles). `todo` / `notes` stamp nothing beyond `@created`.
 */
const MD_STAMP_KEY: Partial<Record<Marker, string>> = {
    ...STATE_TIMESTAMP_KEY,
    moved: 'moved',
};

/** The timestamp metadata key a migrated `marker` carries, or `undefined` (`todo`/`notes`). */
export function stampKeyForMarker(marker: Marker): string | undefined {
    return MD_STAMP_KEY[marker];
}

/**
 * Validate a raw `tsk.migrate.markers` setting value into a glyph→status Map.
 * Tolerant: a non-object yields an empty map; entries with an unknown status
 * name, an empty glyph, or a glyph containing `]` (would break the `[g]`
 * bracket parse) are dropped — each problem `warn`ed, never thrown. An empty
 * result simply matches nothing.
 */
export function validateMarkerMap(
    raw: unknown,
    warn?: (message: string) => void,
): Map<string, Marker> {
    const map = new Map<string, Marker>();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        warn?.('tsk.migrate.markers: not an object — no markers will match');
        return map;
    }
    const validNames = new Set<string>(MARKERS.map((m) => m.name));
    for (const [glyph, status] of Object.entries(raw)) {
        if (glyph === '' || glyph.includes(']')) {
            warn?.(`tsk.migrate.markers: invalid glyph ${JSON.stringify(glyph)} — entry ignored`);
            continue;
        }
        if (typeof status !== 'string' || !validNames.has(status)) {
            warn?.(
                `tsk.migrate.markers: unknown status ${JSON.stringify(status)} for glyph ${JSON.stringify(glyph)} — entry ignored`,
            );
            continue;
        }
        map.set(glyph, status as Marker);
    }
    return map;
}

/** A matched markdown task line, split into its rebuildable parts. */
export interface MdTask {
    /** Leading whitespace, verbatim. */
    indent: string;
    /** The bullet plus its trailing whitespace, verbatim (e.g. `'- '`, `'*   '`). */
    bullet: string;
    /** The matched md glyph (a key of the marker map, e.g. `'>>'`). */
    glyph: string;
    /** Content after the bracket, trailing whitespace trimmed. */
    content: string;
}

/**
 * Match `line` as a markdown task using the configured glyph vocabulary.
 * Unlike tsk's `TASK_LINE_RE` (single-char markers only), glyphs here may be
 * multi-char (`[>>]`) — matched longest-first so a `'>'` entry can coexist
 * with `'>>'`. Returns `null` for non-task lines and unmapped glyphs.
 * Trailing whitespace (incl. a stray `\r`) is excluded from `content`.
 *
 * Stricter than tsk's parser in one deliberate way: the bracket must be
 * followed by whitespace or end-of-line. In markdown `- [x](url)` is a LINK
 * whose text is "x" — tsk's `\]\s*` laxness would migrate it as a task.
 */
export function matchMdTask(line: string, map: ReadonlyMap<string, Marker>): MdTask | null {
    if (map.size === 0) return null;
    const alternation = [...map.keys()]
        .sort((a, b) => b.length - a.length)
        .map((g) => g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
    const re = new RegExp(`^(\\s*)([-*+]\\s+)\\[(${alternation})\\](?:\\s+(.*?))?\\s*$`);
    const match = re.exec(line);
    if (!match) return null;
    return {
        indent: match[1] as string,
        bullet: match[2] as string,
        glyph: match[3] as string,
        content: match[4] ?? '',
    };
}

/** The caller-derived timestamps for one migrating line (git history, or `now` fallbacks). */
export interface MdStamps {
    /** `@created` value — when the line was added. */
    created: string;
    /** The status-stamp value (`@completed`/`@cancelled`/`@moved`/`@started`) — when the current marker was entered. Ignored for `todo`/`notes`. */
    status?: string;
}

/**
 * Rewrite one markdown task line as a tsk task: remap the glyph to the tsk
 * marker, keep indent/bullet/content verbatim, and append a fresh metadata
 * comment — `@id` + `@created`, plus the marker's status stamp when it has
 * one ({@link stampKeyForMarker}) and a value was derived. Returns `null`
 * when the line isn't an md task under `map`, or already carries an `@id`
 * (already tsk — the idempotency rule).
 */
export function migrateMdLine(
    line: string,
    map: ReadonlyMap<string, Marker>,
    stamps: MdStamps,
    id: string,
): string | null {
    const task = matchMdTask(line, map);
    if (!task) return null;
    if (extractMetadata(line).metadata.has('id')) return null;

    const marker = map.get(task.glyph) as Marker;
    const metadata = new Map<string, string | null>([
        ['id', id],
        ['created', stamps.created],
    ]);
    const stampKey = stampKeyForMarker(marker);
    if (stampKey !== undefined && stamps.status !== undefined) {
        metadata.set(stampKey, stamps.status);
    }

    // `- [x] content <!-- … -->`; an empty-content task keeps the two-space
    // shape (`- [x]  <!-- … -->`) the toggle mutators also write.
    const contentPart = task.content === '' ? ' ' : ` ${task.content}`;
    return `${task.indent}${task.bullet}[${GLYPH[marker]}]${contentPart} ${serializeMetadata(metadata)}`;
}

/**
 * A loose "looks like a bracketed task" probe — any glyph, used only to COUNT
 * pass-through lines a relocation would leave semantically dark, never to
 * convert. Same whitespace-after-`]` rule as {@link matchMdTask}.
 */
const BRACKET_PROBE_RE = /^\s*[-*+]\s+\[[^\]]*\](?:\s|$)/;

/** The result of preparing one block of md lines for life in a `.tsk` file. */
export interface PreparedBlock {
    /** The block with every id-less md-task line converted to tsk format. */
    lines: string[];
    /** Block-relative indices this call converted. */
    converted: number[];
    /**
     * Block-relative indices that look like bracketed tasks but were left
     * untouched AND won't parse as tsk either (glyph in neither vocabulary) —
     * surfaced so callers can report them instead of silently shipping them.
     */
    passedThrough: number[];
}

/**
 * Convert every **id-less md-task line** in a block via {@link migrateMdLine};
 * id-carrying (already-tsk) and non-task lines pass through verbatim. This is
 * the shared primitive under every md→tsk relocation (move / send): without
 * it, an id-less `[/]`/`[x]` descendant would land in a `.tsk` file
 * un-remapped and be MISREAD by the glyph collision (md-done `[/]` → tsk
 * in-progress). `stampsFor`/`nextId` are caller-supplied (git derivation +
 * guarded id generation), invoked only for lines actually converted.
 */
export function prepareMdBlockForTsk(
    blockLines: readonly string[],
    map: ReadonlyMap<string, Marker>,
    stampsFor: (blockIndex: number) => MdStamps,
    nextId: () => string,
): PreparedBlock {
    const lines: string[] = [];
    const converted: number[] = [];
    const passedThrough: number[] = [];
    blockLines.forEach((line, i) => {
        const isCandidate =
            matchMdTask(line, map) !== null && !extractMetadata(line).metadata.has('id');
        if (isCandidate) {
            // A pre-filtered candidate can't migrate to null.
            lines.push(migrateMdLine(line, map, stampsFor(i), nextId()) as string);
            converted.push(i);
            return;
        }
        if (BRACKET_PROBE_RE.test(line) && parseLine(line) === null) passedThrough.push(i);
        lines.push(line);
    });
    return { lines, converted, passedThrough };
}
