import { computeMarkerRanges, computeMetadataRanges } from './decorations';
import type { Marker } from './markers';
import type { Task } from './parser';

/** Semantic token types tsk emits for `.tsk` documents. */
export type TskTokenType = 'taskMarker' | 'taskMetadata';

/**
 * One semantic token over a `.tsk` document range. `taskMarker` covers a task's
 * `[X]` triplet and carries its `status` (encoded as the token's modifier);
 * `taskMetadata` covers a whole inline `<!-- ... -->` block (no modifier).
 *
 * Pure (no `vscode`) so vitest can cover positioning without a host; the
 * activation-layer provider maps these onto a `vscode.SemanticTokensBuilder`.
 * Reuses the decoration range computers so positions stay single-sourced with
 * the search-result decoration path.
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
 * tagged by status) and inline metadata blocks (`<!-- ... -->`) — ordered
 * ascending by `(line, char)`, which `SemanticTokensBuilder` requires since it
 * delta-encodes each token against the previous one.
 */
export function computeSemanticTokens(tasks: readonly Task[]): SemanticToken[] {
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
    tokens.sort((a, b) => a.line - b.line || a.char - b.char);
    return tokens;
}
