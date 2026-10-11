import { computeMarkerRanges, computeMetadataRanges } from './decorations';
import { matchDivider } from './divider';
import type { Marker } from './markers';
import type { Task } from './parser';

/** Semantic token types tsk emits for `.tsk` documents. */
export type TskTokenType = 'taskMarker' | 'taskMetadata' | 'taskDivider';

/**
 * One semantic token over a `.tsk` document range. `taskMarker` covers a task's
 * `[X]` triplet and carries its `status` (encoded as the token's modifier);
 * `taskMetadata` covers a whole inline `<!-- ... -->` block (no modifier); and
 * `taskDivider` covers the trailing dash run of a divider line (no modifier),
 * which is pure visual filler — dimming it is what lets the label read as a
 * heading instead of drowning in hyphens. The label itself is left at the
 * default text color, so it pops by contrast rather than by another hex.
 *
 * Pure (no `vscode`) so vitest can cover positioning without a host; the
 * activation-layer provider maps these onto a `vscode.SemanticTokensBuilder`.
 * Reuses the decoration range computers so positions stay single-sourced with
 * the search-result decoration path.
 *
 * The COLORS, however, are NOT single-sourced (they can't be): `taskMetadata`'s
 * default (`#808080`, package.json `configurationDefaults`) mirrors the
 * `tsk.metadata.foreground` decoration that dims the same metadata on
 * Search-Editor result rows — see `constants.ts::METADATA_FOREGROUND_COLOR_ID`.
 * Keep the two in sync by hand.
 */
export interface SemanticToken {
    line: number;
    char: number;
    length: number;
    tokenType: TskTokenType;
    /** Present only for `taskMarker` — the status, used as the token modifier. */
    status?: Marker;
}

/**
 * Compute the semantic tokens for a parsed document — marker triplets (`[X]`,
 * tagged by status), inline metadata blocks (`<!-- ... -->`), and divider dash
 * runs (from `lines`) — ordered
 * ascending by `(line, char)`, which `SemanticTokensBuilder` requires since it
 * delta-encodes each token against the previous one.
 */
export function computeSemanticTokens(
    tasks: readonly Task[],
    /**
     * Raw document lines, needed only for divider dash runs — dividers are not
     * tasks, so `parseDocument` never sees them. Defaults to empty so every
     * existing caller (and test) keeps working unchanged.
     */
    lines: readonly string[] = [],
): SemanticToken[] {
    const tokens: SemanticToken[] = [];
    for (const [status, ranges] of computeMarkerRanges(tasks)) {
        for (const range of ranges) {
            tokens.push({
                line: range.startLine,
                char: range.startCol,
                length: range.endCol - range.startCol,
                tokenType: 'taskMarker',
                status,
            });
        }
    }
    for (const range of computeMetadataRanges(tasks)) {
        tokens.push({
            line: range.startLine,
            char: range.startCol,
            length: range.endCol - range.startCol,
            tokenType: 'taskMetadata',
        });
    }
    lines.forEach((text, line) => {
        const divider = matchDivider(text);
        if (!divider) return;
        tokens.push({
            line,
            char: divider.dashStartCol,
            length: divider.endCol - divider.dashStartCol,
            tokenType: 'taskDivider',
        });
    });
    tokens.sort((a, b) => a.line - b.line || a.char - b.char);
    return tokens;
}
