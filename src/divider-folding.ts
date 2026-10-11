import * as vscode from 'vscode';
import { TSK_LANGUAGE_ID } from './constants';
import { computeFoldRanges } from './lib/folding';

/**
 * The `.tsk` `FoldingRangeProvider`: divider sections (`-label-----` collapses
 * to the next divider) plus the indentation blocks VS Code would otherwise
 * provide itself.
 *
 * Indentation is not an extra — registering a provider REPLACES the built-in
 * indentation strategy, measured rather than assumed; `lib/folding.ts` carries
 * the probe output and the reasoning.
 */
export function registerDividerFolding(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider(
            { language: TSK_LANGUAGE_ID },
            { provideFoldingRanges: (document) => provide(document) },
        ),
    );
}

function provide(document: vscode.TextDocument): vscode.FoldingRange[] {
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) lines.push(document.lineAt(i).text);
    return computeFoldRanges(lines).map(
        (range) =>
            new vscode.FoldingRange(
                range.start,
                range.end,
                // Only the section fold is a `Region`; leaving the indentation
                // ranges kind-less matches what VS Code's own strategy emits,
                // so "Fold All Regions" still means "fold the sections".
                range.kind === 'region' ? vscode.FoldingRangeKind.Region : undefined,
            ),
    );
}
