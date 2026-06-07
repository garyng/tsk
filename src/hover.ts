import * as vscode from 'vscode';
import { TSK_LANGUAGE_ID } from './constants';
import type { CacheService } from './lib/cache';
import type { GraphService } from './lib/graph-service';
import { buildTaskHoverMarkdown, type HoverDeps } from './lib/hover-logic';
import { parseLine } from './lib/parser';
import type { TagsLoader } from './tags-loader';

/**
 * Register a hover provider for `.tsk` documents. For each hovered line
 * that parses as a task, build a markdown popup showing:
 *
 *   - status label (header)
 *   - @id / priority / timestamps (table)
 *   - tags with yaml descriptions (when present)
 *   - parent / depends on / related to with clickable jump-to-target links
 *   - children / dependents / related (count + clickable list)
 *   - file URI + 1-indexed line (footer)
 *
 * The markdown is built by {@link buildTaskHoverMarkdown} (pure, vscode-free)
 * — this layer just wraps it in `vscode.MarkdownString` with
 * `isTrusted: true` so the `command:` URIs in links actually fire.
 */
export function registerHoverProvider(
    context: vscode.ExtensionContext,
    cache: CacheService,
    graph: GraphService,
    tagsLoader: TagsLoader,
): void {
    const deps: HoverDeps = {
        lookupTask: (id) => cache.lookupById(id),
        lookupGraph: (id) => graph.getNode(id),
        lookupTagDescription: (tag) => tagsLoader.getTags().get(tag)?.description,
        now: () => new Date(),
    };

    const provider: vscode.HoverProvider = {
        provideHover(document, position) {
            const lineText = document.lineAt(position.line).text;
            const parsed = parseLine(lineText);
            if (!parsed) return undefined;

            const markdown = buildTaskHoverMarkdown(
                {
                    marker: parsed.marker,
                    metadata: parsed.metadata,
                    tags: parsed.tags,
                    fileUri: document.uri.toString(),
                    line: position.line,
                },
                deps,
            );

            const md = new vscode.MarkdownString(markdown);
            // command: links inside hovers only fire when the MarkdownString
            // is marked trusted. We render command ids we control; no
            // user-supplied input flows into the URI.
            md.isTrusted = true;
            md.supportHtml = false;

            return new vscode.Hover(md, document.lineAt(position.line).range);
        },
    };

    context.subscriptions.push(
        vscode.languages.registerHoverProvider({ language: TSK_LANGUAGE_ID }, provider),
    );
}
