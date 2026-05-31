import * as vscode from 'vscode';
import { TSK_LANGUAGE_ID } from './constants';
import { MARKERS, type Marker } from './lib/markers';
import { parseDocument } from './lib/parser';
import { computeSemanticTokens, type TskTokenType } from './lib/semantic-tokens';

/**
 * Semantic-token coloring for `.tsk` documents — marker triplets (`[X]`, per
 * status) and inline `<!-- ... -->` metadata (dimmed). Unlike the decoration
 * overlay this replaced (M41), semantic tokens are colored by VS Code's
 * tokenization pipeline — the same path as syntax highlighting — so they recolor
 * *with* the text on a toggle/edit, with no reactive round-trip and no debounce.
 * Colors live in `editor.semanticTokenColorCustomizations` (defaults shipped via
 * `package.json#contributes.configurationDefaults`).
 *
 * Two token types: `taskMarker` (status as its single modifier, so rules target
 * `taskMarker.completed`, `taskMarker.cancelled`, …) and `taskMetadata`. `todo`
 * markers ship no color rule → editor default.
 */
const TOKEN_TYPES: readonly TskTokenType[] = ['taskMarker', 'taskMetadata'];
const TOKEN_MODIFIERS: readonly Marker[] = MARKERS.map((m) => m.name);

export const SEMANTIC_TOKENS_LEGEND = new vscode.SemanticTokensLegend(
    [...TOKEN_TYPES],
    [...TOKEN_MODIFIERS],
);

const TYPE_INDEX = new Map<TskTokenType, number>(TOKEN_TYPES.map((type, i) => [type, i]));
/** Status → the single-bit modifier mask for `SemanticTokensBuilder.push`. */
const MODIFIER_BIT = new Map<Marker, number>(TOKEN_MODIFIERS.map((name, i) => [name, 1 << i]));

class TskSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
        const builder = new vscode.SemanticTokensBuilder(SEMANTIC_TOKENS_LEGEND);
        for (const token of computeSemanticTokens(parseDocument(document.getText()))) {
            const modifiers = token.status ? (MODIFIER_BIT.get(token.status) ?? 0) : 0;
            builder.push(
                token.line,
                token.char,
                token.length,
                TYPE_INDEX.get(token.tokenType) ?? 0,
                modifiers,
            );
        }
        return builder.build();
    }
}

/**
 * Register the `.tsk` document semantic-tokens provider. VS Code requests tokens
 * on open and after edits (its own short, cached debounce) and paints them in
 * the tokenization pass, so marker / metadata colors track the text instantly.
 */
export function registerSemanticTokens(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { language: TSK_LANGUAGE_ID },
            new TskSemanticTokensProvider(),
            SEMANTIC_TOKENS_LEGEND,
        ),
    );
}
