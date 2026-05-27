import * as vscode from 'vscode';
import { TSK_LANGUAGE_ID } from './constants';
import type { CacheService } from './lib/cache';
import { findTagPrefixContext } from './lib/tags-completion-logic';
import { mergeTagDefs } from './lib/tags-config';
import type { TagsLoader } from './tags-loader';

const TRIGGER_CHARACTER = '#';

/**
 * Register a `#`-triggered completion provider that surfaces every known
 * tag — yaml-declared first, then cache-discovered (with implicit parents
 * filled in). The pure logic (`findTagPrefixContext` + `mergeTagDefs`)
 * lives in `src/lib/**`; this module just adapts it to the VSCode API
 * surface.
 *
 * The provider returns the same item set regardless of the partial
 * typed; VSCode does its own fuzzy filtering using each item's
 * `filterText` (set to the tag name so matching feels intuitive — both
 * substring and CamelCase scoring kick in).
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
                if (def.description) item.detail = def.description;
                item.insertText = name;
                item.filterText = name;
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
