import * as vscode from 'vscode';
import { AUTOLINKS_KEY, AUTOLINKS_SETTING, TSK_LANGUAGE_ID } from './constants';
import { type CompiledAutoLink, computeAutoLinkSpans, parseAutoLinkRules } from './lib/autolinks';
import type { Logger } from './lib/logger';

/**
 * Owns the `tsk.autolinks` `DocumentLinkProvider` and keeps it current.
 *
 * `DocumentLinkProvider` has **no `onDidChange*` event** (unlike CodeLens), so
 * VS Code caches the links it last computed and won't re-query on a bare config
 * change. To force a refresh we dispose + re-register the provider whenever
 * `tsk.autolinks` changes — the same dispose+rebuild lifecycle the tags-loader
 * uses for its watcher. Rules are compiled once per change (in {@link reload}),
 * not per `provideDocumentLinks` call.
 *
 * The pure matching/substitution lives in `lib/autolinks.ts`; this module is
 * the thin VS Code adapter (text → ranges → `vscode.DocumentLink`).
 */
export class AutoLinksController implements vscode.Disposable {
    private rules: CompiledAutoLink[] = [];
    private registration: vscode.Disposable | undefined;
    private readonly configSub: vscode.Disposable;

    constructor(private readonly logger: Logger) {
        this.reload();
        this.register();
        this.configSub = vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(AUTOLINKS_SETTING)) this.refresh();
        });
    }

    /**
     * Re-read `tsk.autolinks` and re-register the provider (busting VS Code's
     * link cache). Wired to the config listener; also exposed via
     * `TskExtensionApi` so e2e tests can force a deterministic refresh after a
     * `getConfiguration().update`, sidestepping the change-event timing.
     */
    refresh(): void {
        this.reload();
        this.registration?.dispose();
        this.register();
        this.logger.info(`${AUTOLINKS_SETTING}: ${this.rules.length} rule(s) active.`);
    }

    private reload(): void {
        const raw = vscode.workspace.getConfiguration('tsk').get<unknown>(AUTOLINKS_KEY);
        const { rules, warnings } = parseAutoLinkRules(raw);
        this.rules = rules;
        for (const warning of warnings) this.logger.warn(warning);
    }

    private register(): void {
        this.registration = vscode.languages.registerDocumentLinkProvider(
            { language: TSK_LANGUAGE_ID },
            { provideDocumentLinks: (document) => this.provide(document) },
        );
    }

    private provide(document: vscode.TextDocument): vscode.DocumentLink[] {
        if (this.rules.length === 0) return [];
        const links: vscode.DocumentLink[] = [];
        for (let line = 0; line < document.lineCount; line++) {
            const text = document.lineAt(line).text;
            for (const span of computeAutoLinkSpans(text, this.rules)) {
                let uri: vscode.Uri;
                try {
                    uri = vscode.Uri.parse(span.target, /* strict */ true);
                } catch {
                    // Usually a look-around no-op target (the raw match, no
                    // scheme) — see lib/autolinks.ts. Debug-level so a frequently
                    // re-queried provider doesn't spam the Output channel.
                    this.logger.debug(
                        `autolinks: skipping invalid URI ${JSON.stringify(span.target)}`,
                    );
                    continue;
                }
                const range = new vscode.Range(line, span.startCol, line, span.endCol);
                const link = new vscode.DocumentLink(range, uri);
                link.tooltip = uri.toString(true);
                links.push(link);
            }
        }
        return links;
    }

    dispose(): void {
        this.registration?.dispose();
        this.configSub.dispose();
    }
}

/** Register the autolinks provider; returns the controller for `TskExtensionApi`. */
export function registerAutoLinksProvider(
    context: vscode.ExtensionContext,
    logger: Logger,
): AutoLinksController {
    const controller = new AutoLinksController(logger);
    context.subscriptions.push(controller);
    return controller;
}
