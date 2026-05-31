import {
    computeMarkerRanges,
    computeMetadataRanges,
    computePriorityRanges,
    type RangeLike,
} from './decorations';
import type { Marker } from './markers';
import { parseLine, type Task } from './parser';
import type { PriorityLevel } from './priorities';

/**
 * A Search Editor **match** result row: `␣␣<pad><lineNo>:␣<content>`.
 *
 * Two leading spaces, the line number right-aligned to the widest in the
 * result set, then `: ` (colon-space). Context rows use `␣␣` instead of `: `
 * and so don't match — and with `contextLines: 0` (M30/A) there are none.
 * Shape pulled from VS Code's `searchEditorSerialization.ts`; it's undocumented,
 * hence this single regex is the one brittle dependency (see the M30/B notes).
 */
const MATCH_LINE_RE = /^( {2,}\d+: )(.*)$/;

export interface SearchResultRanges {
    markers: Map<Marker, RangeLike[]>;
    priorities: Map<PriorityLevel, RangeLike[]>;
    metadata: RangeLike[];
}

/**
 * Compute tsk decoration ranges for the match rows of a Search Editor result
 * document, offset by each row's gutter so they land on the result row rather
 * than the original file position.
 *
 * For each match row we strip the gutter prefix, parse the `<content>` as a tsk
 * line, run the normal decoration computations (which yield *content-relative*
 * columns against a synthetic `Task` whose `line` is the result-row index), then
 * shift every column right by that row's prefix width. Non-match rows (file-path
 * headers, the query/flags header, blanks) parse to nothing and contribute no
 * ranges.
 *
 * Pure — no `vscode` import; the activation layer maps the ranges to
 * `vscode.Range` and applies the shared decoration types.
 */
export function computeSearchResultRanges(text: string): SearchResultRanges {
    const tasks: Task[] = [];
    const prefixByLine = new Map<number, number>();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const match = MATCH_LINE_RE.exec(lines[i] as string);
        if (!match) continue;
        const parsed = parseLine(match[2] as string);
        if (!parsed) continue;
        tasks.push({ ...parsed, line: i });
        prefixByLine.set(i, (match[1] as string).length);
    }

    const shift = (r: RangeLike): RangeLike => {
        const offset = prefixByLine.get(r.startLine) ?? 0;
        return {
            startLine: r.startLine,
            startCol: r.startCol + offset,
            endLine: r.endLine,
            endCol: r.endCol + offset,
        };
    };
    const shiftMap = <K>(map: Map<K, RangeLike[]>): Map<K, RangeLike[]> => {
        const out = new Map<K, RangeLike[]>();
        for (const [key, ranges] of map) out.set(key, ranges.map(shift));
        return out;
    };

    return {
        markers: shiftMap(computeMarkerRanges(tasks)),
        priorities: shiftMap(computePriorityRanges(tasks)),
        metadata: computeMetadataRanges(tasks).map(shift),
    };
}
