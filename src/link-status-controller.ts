import { formatDistance } from 'date-fns';
import * as vscode from 'vscode';
import { AUTOLINKS_KEY, COMMANDS, LINK_STATUS_SETTING, TSK_LANGUAGE_ID } from './constants';
import { isTskDocument } from './editor-guards';
import { type CompiledAutoLink, parseAutoLinkRules } from './lib/autolinks';
import { scheduleDebounced } from './lib/debounce';
import { findLinks, type LinkSpan } from './lib/link-status/links';
import { type Connector, FetchQueue } from './lib/link-status/queue';
import { parseScriptConnectors, scriptConnector } from './lib/link-status/script-connector';
import { type Entry, isFresh } from './lib/link-status/status';
import { StatusCache } from './lib/link-status/status-cache';
import type { Logger } from './lib/logger';

/**
 * The status of the links in `.tsk` editors: drawn after each link whose status
 * is known, fetched for the links on screen and a screen either side.
 *
 * Two decorations per link, both at its end: the status as `before` text on
 * the empty range there, the checks glyph as `after` text on the link. VS Code
 * draws injected text at one column `before` first (its `fromDecorations`
 * sorts on line, column, then before/after), so the order holds whatever the
 * decorations' history.
 */

const CACHE_KEY = 'tsk.linkStatus.cache';
const SCROLL_DEBOUNCE_MS = 150;
const EDIT_DEBOUNCE_MS = 300;
const RENDER_DEBOUNCE_MS = 50;
const PERSIST_DEBOUNCE_MS = 2000;
const CHECKS_GLYPH = { passing: '✓', failing: '✗', pending: '○' } as const;

/** A drawn status, for the e2e API: VS Code doesn't hand back what decorations show. */
export interface LinkStatusMark {
    readonly line: number;
    readonly startCol: number;
    readonly endCol: number;
    readonly url: string;
    /** What's drawn after the link, e.g. `● open ✓`. */
    readonly text: string;
}

interface DocLinks {
    readonly version: number;
    readonly links: readonly { readonly line: number; readonly span: LinkSpan }[];
    /** Each line's links by its text, for the next version: an edit rescans only the lines it changed. */
    readonly byText: ReadonlyMap<string, readonly LinkSpan[]>;
}

export class LinkStatusController implements vscode.Disposable {
    private readonly cache: StatusCache;
    private queue: FetchQueue;
    private autolinks: CompiledAutoLink[] = [];
    private readonly docLinks = new Map<string, DocLinks>();
    private readonly marks = new Map<string, LinkStatusMark[]>();
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly statusType = vscode.window.createTextEditorDecorationType({
        before: { margin: '0 0 0 0.6em' },
    });
    private readonly checksType = vscode.window.createTextEditorDecorationType({
        after: { margin: '0 0 0 0.3em' },
    });
    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly logger: Logger,
    ) {
        this.cache = StatusCache.from(context.globalState.get(CACHE_KEY));
        this.queue = this.configure();
        this.subscriptions.push(
            this.statusType,
            this.checksType,
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (
                    e.affectsConfiguration(LINK_STATUS_SETTING) ||
                    e.affectsConfiguration('tsk.autolinks')
                )
                    this.reconfigure();
            }),
            vscode.workspace.onDidGrantWorkspaceTrust(() => this.reconfigure()),
            vscode.window.onDidChangeVisibleTextEditors((editors) => {
                for (const editor of editors) this.update(editor);
            }),
            vscode.window.onDidChangeTextEditorVisibleRanges(({ textEditor }) => {
                if (!isTskDocument(textEditor.document)) return;
                // Per editor: two side by side on one file scroll apart.
                const key = `scroll:${textEditor.document.uri}:${textEditor.viewColumn}`;
                scheduleDebounced(this.timers, key, SCROLL_DEBOUNCE_MS, () =>
                    this.want(textEditor),
                );
            }),
            vscode.workspace.onDidChangeTextDocument(({ document }) => {
                if (!isTskDocument(document)) return;
                scheduleDebounced(this.timers, `edit:${document.uri}`, EDIT_DEBOUNCE_MS, () => {
                    for (const editor of vscode.window.visibleTextEditors)
                        if (editor.document === document) this.update(editor);
                });
            }),
            vscode.workspace.onDidCloseTextDocument((document) => {
                this.docLinks.delete(document.uri.toString());
                this.marks.delete(document.uri.toString());
            }),
            vscode.languages.registerHoverProvider(
                { language: TSK_LANGUAGE_ID },
                { provideHover: (document, position) => this.hover(document, position) },
            ),
            vscode.commands.registerCommand(COMMANDS.refreshLinkStatus, () => this.refresh()),
        );
        for (const editor of vscode.window.visibleTextEditors) this.update(editor);
    }

    /** What's drawn in `uri`'s editors, for the e2e API. */
    getMarks(uri: string): readonly LinkStatusMark[] | undefined {
        return this.marks.get(uri);
    }

    /** Fetch the links on screen again, fresh or not. */
    refresh(): void {
        for (const editor of vscode.window.visibleTextEditors) this.want(editor, true);
    }

    dispose(): void {
        this.queue.dispose();
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        void this.context.globalState.update(CACHE_KEY, this.cache.toJSON());
        for (const s of this.subscriptions) s.dispose();
    }

    /** The connectors from settings, and a queue over them; autolinks too, which name links. */
    private configure(): FetchQueue {
        const config = vscode.workspace.getConfiguration('tsk');
        this.autolinks = parseAutoLinkRules(config.get<unknown>(AUTOLINKS_KEY)).rules;
        const connectors: Connector[] = [];
        // A connector runs a program, so only in a trusted folder: a repo's own settings may name
        // one, as its tasks may run one. tsk declares no untrusted support, so VS Code doesn't run
        // it in one at all; the check says the rule here too.
        let from = '';
        if (vscode.workspace.isTrusted) {
            const raw = config.inspect<unknown>('linkStatus.connectors');
            from =
                raw?.workspaceFolderValue !== undefined || raw?.workspaceValue !== undefined
                    ? ' (workspace settings)'
                    : '';
            const { configs, warnings } = parseScriptConnectors(
                config.get<unknown>('linkStatus.connectors'),
            );
            for (const w of warnings) this.logger.warn(w);
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            for (const c of configs)
                connectors.push(
                    scriptConnector(c, {
                        cwd,
                        log: (line) => this.logger.info(`link status: ${line}`),
                    }),
                );
        }
        this.logger.info(
            `link status: ${connectors.length} connector(s)${from}: ${connectors.map((c) => c.name).join(', ') || 'none'}`,
        );
        return new FetchQueue(connectors, {
            now: Date.now,
            log: this.logger,
            onEntry: (url, entry) => this.record(url, entry),
        });
    }

    private reconfigure(): void {
        this.queue.dispose();
        this.queue = this.configure();
        this.docLinks.clear();
        for (const editor of vscode.window.visibleTextEditors) this.update(editor);
    }

    private record(url: string, entry: Entry): void {
        this.cache.set(url, entry);
        scheduleDebounced(this.timers, 'persist', PERSIST_DEBOUNCE_MS, () => {
            void this.context.globalState.update(CACHE_KEY, this.cache.toJSON());
        });
        scheduleDebounced(this.timers, 'render', RENDER_DEBOUNCE_MS, () => {
            for (const editor of vscode.window.visibleTextEditors) this.render(editor);
        });
    }

    private update(editor: vscode.TextEditor): void {
        if (!isTskDocument(editor.document)) return;
        this.render(editor);
        this.want(editor);
    }

    private links(document: vscode.TextDocument): DocLinks['links'] {
        const key = document.uri.toString();
        const known = this.docLinks.get(key);
        if (known?.version === document.version) return known.links;
        // 25-50 ms for a 2000-line file with a link on every other line, so once per line text.
        const links: { line: number; span: LinkSpan }[] = [];
        const byText = new Map<string, readonly LinkSpan[]>();
        for (let line = 0; line < document.lineCount; line++) {
            const text = document.lineAt(line).text;
            const spans =
                byText.get(text) ?? known?.byText.get(text) ?? findLinks(text, this.autolinks);
            byText.set(text, spans);
            for (const span of spans) links.push({ line, span });
        }
        this.docLinks.set(key, { version: document.version, links, byText });
        return links;
    }

    /** Draw every link whose status is known, on screen or not. */
    private render(editor: vscode.TextEditor): void {
        if (!isTskDocument(editor.document)) return;
        const statuses: vscode.DecorationOptions[] = [];
        const checks: vscode.DecorationOptions[] = [];
        const marks: LinkStatusMark[] = [];
        for (const { line, span } of this.links(editor.document)) {
            const entry = this.cache.get(span.url);
            if (!entry || !('status' in entry)) continue;
            const { label, category, checks: state } = entry.status;
            const text = `● ${label}`;
            statuses.push({
                range: new vscode.Range(line, span.endCol, line, span.endCol),
                renderOptions: {
                    before: {
                        contentText: text,
                        color: new vscode.ThemeColor(`tsk.linkStatus.${category.toLowerCase()}`),
                    },
                },
            });
            if (state)
                checks.push({
                    range: new vscode.Range(line, span.startCol, line, span.endCol),
                    renderOptions: {
                        after: {
                            contentText: CHECKS_GLYPH[state],
                            color: new vscode.ThemeColor(`tsk.linkStatus.checks.${state}`),
                        },
                    },
                });
            marks.push({ line, ...span, text: state ? `${text} ${CHECKS_GLYPH[state]}` : text });
        }
        editor.setDecorations(this.statusType, statuses);
        editor.setDecorations(this.checksType, checks);
        this.marks.set(editor.document.uri.toString(), marks);
    }

    /** Ask for the links on screen and a screen either side, those not known or not fresh: on screen first. */
    private want(editor: vscode.TextEditor, force = false): void {
        if (!isTskDocument(editor.document)) return;
        const now = Date.now();
        const where = (line: number): 'view' | 'near' | undefined => {
            let near = false;
            for (const r of editor.visibleRanges) {
                if (line >= r.start.line && line <= r.end.line) return 'view';
                const height = r.end.line - r.start.line + 1;
                near ||= line >= r.start.line - height && line <= r.end.line + height;
            }
            return near ? 'near' : undefined;
        };
        const inView: string[] = [];
        const around: string[] = [];
        for (const { line, span } of this.links(editor.document)) {
            const place = where(line);
            const entry = place && this.cache.get(span.url);
            if (!place || (!force && entry && isFresh(entry, now))) continue;
            (place === 'view' ? inView : around).push(span.url);
        }
        // The queue asks in the order it's given.
        this.queue.want([...inView, ...around]);
    }

    private hover(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.Hover | undefined {
        const link = this.links(document).find(
            ({ line, span }) =>
                line === position.line &&
                position.character >= span.startCol &&
                position.character < span.endCol,
        );
        const entry = link && this.cache.get(link.span.url);
        if (!link || !entry) return undefined;
        // What a connector says is the service's text: appendText escapes it, and the string isn't trusted.
        const md = new vscode.MarkdownString();
        if ('status' in entry) {
            const { title, label, checks, lines } = entry.status;
            if (title) {
                md.appendMarkdown('**');
                md.appendText(title);
                md.appendMarkdown('**\n\n');
            }
            md.appendText(checks ? `● ${label} · checks ${checks}` : `● ${label}`);
            for (const line of lines ?? []) {
                md.appendMarkdown('\n\n');
                md.appendText(line);
            }
        } else md.appendText(`No status: ${entry.error}`);
        md.appendMarkdown('\n\n');
        md.appendText(
            `fetched ${formatDistance(entry.fetchedAt, Date.now(), { addSuffix: true })}`,
        );
        const { line, span } = link;
        return new vscode.Hover(md, new vscode.Range(line, span.startCol, line, span.endCol));
    }
}

export function registerLinkStatus(
    context: vscode.ExtensionContext,
    logger: Logger,
): LinkStatusController {
    const controller = new LinkStatusController(context, logger);
    context.subscriptions.push(controller);
    return controller;
}
