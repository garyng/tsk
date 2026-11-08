import { formatDistance } from 'date-fns';
import * as vscode from 'vscode';
import { AUTOLINKS_KEY, COMMANDS, LINK_STATUS_SETTING, TSK_LANGUAGE_ID } from './constants';
import { isTskDocument } from './editor-guards';
import { type CompiledAutoLink, parseAutoLinkRules } from './lib/autolinks';
import { scheduleDebounced } from './lib/debounce';
import { githubConnector, NOT_SIGNED_IN } from './lib/link-status/github';
import {
    type JiraCredentials,
    jiraConnector,
    jiraIssue,
    NO_TOKEN,
    REFUSED,
} from './lib/link-status/jira';
import { findLinks, type LinkSpan } from './lib/link-status/links';
import { type Connector, FetchQueue } from './lib/link-status/queue';
import { parseScriptConnectors, scriptConnector } from './lib/link-status/script-connector';
import { type Entry, isFresh } from './lib/link-status/status';
import { StatusCache } from './lib/link-status/status-cache';
import type { Logger } from './lib/logger';
import {
    chipText,
    FLOATING,
    floatingOptions,
    INLINE,
    inlayHintsReserve,
    inlineOptions,
    reserve,
} from './link-status-chip';

/**
 * The status of the links in `.tsk` editors: drawn after each link whose status
 * is known, fetched for the links on screen and a screen either side. How a
 * status is drawn, and why it floats over an inlay hint: `link-status-chip.ts`.
 */

/**
 * Per workspace, as the connectors are (a repo's settings can name them): the statuses no
 * connector here takes are dropped when the connectors change, which a cache shared by every
 * window would do to another workspace's.
 */
const CACHE_KEY = 'tsk.linkStatus.cache';
/** The hover's Open: internal, so not contributed (COMMANDS mirrors what is). */
const OPEN_LINK = 'tsk.openLink';
/** A PR's or issue's state in a private repo needs `repo`; GitHub's OAuth has no read-only form of it. */
const GITHUB_SCOPES = ['repo'];
/** A Jira site's email and API token in secret storage, as JSON: one entry per site. */
const jiraSecret = (site: string) => `tsk.linkStatus.jira.token:${site}`;
/** The email last given for a site, to offer for the next one (not secret). */
const JIRA_LAST_EMAIL = 'tsk.linkStatus.jira.lastEmail';
const SCROLL_DEBOUNCE_MS = 150;
const EDIT_DEBOUNCE_MS = 300;
const RENDER_DEBOUNCE_MS = 50;
const PERSIST_DEBOUNCE_MS = 2000;

/** A drawn status, for the e2e API: VS Code doesn't hand back what decorations show. */
export interface LinkStatusMark {
    readonly line: number;
    readonly startCol: number;
    readonly endCol: number;
    readonly url: string;
    /** The chip drawn after the link, e.g. `In review ✗`. */
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
    private readonly floatingType = vscode.window.createTextEditorDecorationType(FLOATING);
    private readonly inlineType = vscode.window.createTextEditorDecorationType(INLINE);
    private readonly inlayChanged = new vscode.EventEmitter<void>();
    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly logger: Logger,
    ) {
        this.cache = StatusCache.from(context.workspaceState.get(CACHE_KEY));
        // 0.12 and 0.13.0 kept one cache for every window.
        void context.globalState.update(CACHE_KEY, undefined);
        this.queue = this.configure();
        this.prune();
        this.subscriptions.push(
            this.floatingType,
            this.inlineType,
            this.inlayChanged,
            vscode.languages.registerInlayHintsProvider(
                { language: TSK_LANGUAGE_ID },
                {
                    onDidChangeInlayHints: this.inlayChanged.event,
                    provideInlayHints: (document, range) => this.inlayHints(document, range),
                },
            ),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (
                    e.affectsConfiguration(LINK_STATUS_SETTING) ||
                    e.affectsConfiguration('tsk.autolinks')
                )
                    this.reconfigure();
                // Whether a chip can float over an inlay hint (`inlayHintsReserve`).
                else if (
                    e.affectsConfiguration('editor.inlayHints') ||
                    e.affectsConfiguration('editor.fontSize') ||
                    e.affectsConfiguration('editor.fontFamily')
                )
                    for (const editor of vscode.window.visibleTextEditors) this.render(editor);
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
            vscode.commands.registerCommand(COMMANDS.refreshLinkStatus, (url?: string) =>
                typeof url === 'string' ? this.queue.want([url]) : this.refresh(),
            ),
            vscode.commands.registerCommand(OPEN_LINK, (url: string) =>
                vscode.env.openExternal(vscode.Uri.parse(url)),
            ),
            vscode.commands.registerCommand(COMMANDS.signInToGitHub, () => this.signInToGitHub()),
            vscode.commands.registerCommand(COMMANDS.clearLinkStatusCache, () => this.clearCache()),
            vscode.commands.registerCommand(COMMANDS.setJiraApiToken, (site?: string) =>
                this.setJiraToken(site),
            ),
            context.secrets.onDidChange(({ key }) => {
                if (key.startsWith('tsk.linkStatus.jira.token:')) this.refresh();
            }),
            // Signed in, out, or as someone else: what's on screen may read differently now.
            vscode.authentication.onDidChangeSessions(({ provider }) => {
                if (provider.id === 'github') this.refresh();
            }),
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
        this.persist();
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
        // Any Atlassian Cloud site the links point to; one with no token kept is never asked.
        connectors.push(jiraConnector({ credentials: (site) => this.jiraCredentials(site) }));
        // After yours, so one of yours can take github.com over.
        if (config.get<boolean>('linkStatus.github.enabled'))
            connectors.push(githubConnector({ token: () => this.githubToken() }));
        this.logger.info(
            `link status: ${connectors.length} connector(s)${from}: ${connectors.map((c) => c.name).join(', ') || 'none'}`,
        );
        return new FetchQueue(connectors, {
            now: Date.now,
            log: this.logger,
            onEntry: (url, entry) => this.record(url, entry),
        });
    }

    /** A site's email and token from secret storage; undefined when there are none. */
    private async jiraCredentials(site: string): Promise<JiraCredentials | undefined> {
        const raw = await this.context.secrets.get(jiraSecret(site));
        if (!raw) return undefined;
        try {
            const { email, token } = JSON.parse(raw) as Partial<JiraCredentials>;
            if (typeof email === 'string' && typeof token === 'string') return { email, token };
        } catch {
            // 0.14.0 kept the token alone, with the email in settings: asked for again.
        }
        this.logger.warn(
            `link status: the Jira credentials kept for ${site} aren't readable; set them again`,
        );
        return undefined;
    }

    /**
     * Ask for a Jira site's email and API token, and keep them in secret storage: the site
     * given (a link's hover gives its own), else asked for. An empty token removes them.
     */
    private async setJiraToken(given?: string): Promise<void> {
        const site = typeof given === 'string' ? given : await this.askJiraSite();
        if (!site) return;
        const host = new URL(site).host;
        const kept = await this.jiraCredentials(site);
        const email = await vscode.window.showInputBox({
            title: `Jira at ${host}: your Atlassian account's email`,
            value: kept?.email ?? this.context.globalState.get<string>(JIRA_LAST_EMAIL) ?? '',
            ignoreFocusOut: true,
            validateInput: (v) => (/^\S+@\S+$/.test(v.trim()) ? undefined : 'An email address'),
        });
        if (email === undefined) return;
        const token = await vscode.window.showInputBox({
            title: `Jira at ${host}: the API token for ${email.trim()}`,
            prompt: 'From id.atlassian.com, Security, API tokens. Empty removes the one kept.',
            password: true,
            ignoreFocusOut: true,
        });
        if (token === undefined) return;
        if (token.trim() === '') {
            await this.context.secrets.delete(jiraSecret(site));
            return;
        }
        await this.context.globalState.update(JIRA_LAST_EMAIL, email.trim());
        await this.context.secrets.store(
            jiraSecret(site),
            JSON.stringify({ email: email.trim(), token: token.trim() }),
        );
    }

    private async askJiraSite(): Promise<string | undefined> {
        const site = await vscode.window.showInputBox({
            title: 'Jira site',
            placeHolder: 'https://example.atlassian.net',
            ignoreFocusOut: true,
            validateInput: (v) =>
                jiraIssue(`${this.originOf(v)}/browse/A-1`)
                    ? undefined
                    : 'An Atlassian Cloud site: https://<name>.atlassian.net',
        });
        return site === undefined ? undefined : this.originOf(site);
    }

    private originOf(text: string): string {
        try {
            return new URL(text.trim()).origin.toLowerCase();
        } catch {
            return '';
        }
    }

    /** The editor's GitHub session's token, without asking: undefined when there's none. */
    private async githubToken(): Promise<string | undefined> {
        try {
            const session = await vscode.authentication.getSession('github', GITHUB_SCOPES, {
                silent: true,
            });
            return session?.accessToken;
        } catch (e) {
            this.logger.warn(`link status: no GitHub session: ${(e as Error).message}`);
            return undefined;
        }
    }

    /** VS Code's own GitHub sign-in, then the links on screen again. */
    private async signInToGitHub(): Promise<void> {
        try {
            await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: true });
            this.refresh();
        } catch (e) {
            this.logger.warn(`link status: GitHub sign-in: ${(e as Error).message}`);
        }
    }

    private reconfigure(): void {
        this.queue.dispose();
        this.queue = this.configure();
        this.prune();
        this.docLinks.clear();
        for (const editor of vscode.window.visibleTextEditors) this.update(editor);
    }

    /** Forget the statuses no connector takes now: one removed from settings takes its own along. */
    private prune(): void {
        const dropped = this.cache.prune((url) => this.queue.knows(url));
        if (dropped === 0) return;
        this.logger.info(`link status: dropped ${dropped} cached status(es) no connector takes`);
        this.persist();
    }

    /** Empty the cache, and fetch what's on screen again. */
    clearCache(): void {
        this.cache.clear();
        this.persist();
        for (const editor of vscode.window.visibleTextEditors) this.update(editor);
    }

    private persist(): void {
        void this.context.workspaceState.update(CACHE_KEY, this.cache.toJSON());
    }

    private record(url: string, entry: Entry): void {
        this.cache.set(url, entry);
        scheduleDebounced(this.timers, 'persist', PERSIST_DEBOUNCE_MS, () => this.persist());
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
        const floats = inlayHintsReserve(editor.document);
        const chips: vscode.DecorationOptions[] = [];
        const marks: LinkStatusMark[] = [];
        for (const { line, span } of this.links(editor.document)) {
            const entry = this.cache.get(span.url);
            // Only a link a connector takes now: one removed from settings leaves its links bare.
            if (!entry || !('status' in entry) || !this.queue.knows(span.url)) continue;
            chips.push({
                range: new vscode.Range(line, span.endCol, line, span.endCol),
                renderOptions: floats ? floatingOptions(entry.status) : inlineOptions(entry.status),
            });
            marks.push({ line, ...span, text: chipText(entry.status).trim() });
        }
        editor.setDecorations(floats ? this.floatingType : this.inlineType, chips);
        editor.setDecorations(floats ? this.inlineType : this.floatingType, []);
        this.marks.set(editor.document.uri.toString(), marks);
        this.inlayChanged.fire();
    }

    /**
     * The blank hint each floating chip covers: it takes the chip's room when the line wraps,
     * and the clicks the chip lets through: Ctrl+Click opens the link, hovering shows the details.
     */
    private inlayHints(document: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
        if (!inlayHintsReserve(document)) return [];
        const hints: vscode.InlayHint[] = [];
        for (const { line, span } of this.links(document)) {
            if (line < range.start.line || line > range.end.line) continue;
            const entry = this.cache.get(span.url);
            if (!entry || !('status' in entry) || !this.queue.knows(span.url)) continue;
            const part = new vscode.InlayHintLabelPart(reserve(entry.status));
            part.tooltip = this.details(entry, span.url);
            part.command = { title: 'Open', command: OPEN_LINK, arguments: [span.url] };
            hints.push(new vscode.InlayHint(new vscode.Position(line, span.endCol), [part]));
        }
        return hints;
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
                // At the end too: the status is drawn there, and hovering it reports that position.
                position.character <= span.endCol,
        );
        const entry = link && this.queue.knows(link.span.url) && this.cache.get(link.span.url);
        if (!link || !entry) return undefined;
        const { line, span } = link;
        return new vscode.Hover(
            this.details(entry, span.url),
            new vscode.Range(line, span.startCol, line, span.endCol),
        );
    }

    private details(entry: Entry, url: string): vscode.MarkdownString {
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
        // Only these commands run from it, whatever the service's text holds.
        const arg = encodeURIComponent(JSON.stringify([url]));
        md.appendMarkdown(
            `\n\n[Open](command:${OPEN_LINK}?${arg}) · [Refresh](command:${COMMANDS.refreshLinkStatus}?${arg})`,
        );
        if ('error' in entry && entry.error === NOT_SIGNED_IN)
            md.appendMarkdown(` · [Sign in to GitHub](command:${COMMANDS.signInToGitHub})`);
        const jira = jiraIssue(url);
        if (
            jira &&
            'error' in entry &&
            (entry.error.startsWith(NO_TOKEN) || entry.error.startsWith(REFUSED))
        ) {
            const site = encodeURIComponent(JSON.stringify([jira.site]));
            md.appendMarkdown(
                ` · [Set Jira API Token](command:${COMMANDS.setJiraApiToken}?${site})`,
            );
        }
        md.isTrusted = {
            enabledCommands: [
                OPEN_LINK,
                COMMANDS.refreshLinkStatus,
                COMMANDS.signInToGitHub,
                COMMANDS.setJiraApiToken,
            ],
        };
        return md;
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
