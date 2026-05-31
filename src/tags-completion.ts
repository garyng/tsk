import * as vscode from 'vscode';
import { TSK_LANGUAGE_ID } from './constants';
import type { CacheService } from './lib/cache';
import { buildTagFilterText, findTagPrefixContext } from './lib/tags-completion-logic';
import { mergeTagDefs } from './lib/tags-config';
import type { TagsLoader } from './tags-loader';

const TRIGGER_CHARACTER = '#';

/**
 * Register a `#`-triggered completion provider that surfaces every known
 * tag — yaml-declared first, then cache-discovered (with implicit parents
 * filled in). The pure logic (`findTagPrefixContext` + `mergeTagDefs` +
 * `buildTagFilterText`) lives in `src/lib/**`; this module just adapts
 * it to the VSCode API surface.
 *
 * **Description-driven matching.** `item.filterText` includes both the
 * tag name and the yaml description (name first, so exact-prefix matches
 * still rank highest). Typing `infrastructure` finds a tag whose name is
 * `homelab` but whose description carries the word — same way
 * `matchOnDescription: true` works on a QuickPick.
 *
 * **Description visibility.** `detail` shows in the right column of the
 * suggestion list (single line); `documentation` powers the side-panel
 * doc popup. Setting both gives users two places to see the description
 * — at-a-glance in the list, full text in the popup. Same source string;
 * the redundancy is on VSCode's side, not ours.
 */
export function registerTagsCompletionProvider(
    context: vscode.ExtensionContext,
    cache: CacheService,
    loader: TagsLoader,
): void {
    const provider: vscode.CompletionItemProvider = {
        provideCompletionItems(document, position) {
            const line = document.lineAt(position.line).text;
            const ctx = findTagPrefixContext(line, position.character);
            if (!ctx) return undefined;

            const replaceRange = new vscode.Range(
                position.line,
                ctx.startCol,
                position.line,
                ctx.endCol,
            );
            const merged = mergeTagDefs(loader.getTags(), cache.listAllTags());
            const items: vscode.CompletionItem[] = [];
            for (const [name, def] of merged) {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Value);
                if (def.description) {
                    item.detail = def.description;
                    item.documentation = new vscode.MarkdownString(def.description);
                }
                item.insertText = name;
                item.filterText = buildTagFilterText(name, def.description);
                item.range = replaceRange;
                items.push(item);
            }
            return items;
        },
    };

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: TSK_LANGUAGE_ID },
            provider,
            TRIGGER_CHARACTER,
        ),
    );
}
