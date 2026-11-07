import path from 'node:path';
import { Box, Text, useApp, useCursor, useInput, usePaste, useStdin, useWindowSize } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import stringWidth from 'string-width';
import { anchorIndex, markdownLines } from '../lib/markdown-lines';
import type { Marker } from '../lib/markers';
import { headingFor, type MarkdownHeading, markdownHeadings } from '../lib/md-headings';
import { sessionFocus } from '../lib/session-focus';
import { lookupId, outsideFileOf, type TaskTree, type TreeNode } from '../lib/task-tree';
import { type Delivery, elapsed, type MessageSubject, messageText } from '../lib/tui-ask';
import type { SelectReply } from '../lib/tui-channel';
import {
    detailWindow,
    factLines,
    linkedFile,
    namedLine,
    shareAt,
    splitPane,
    stepShare,
    taskFacts,
} from '../lib/tui-detail';
import { filterTerms, inputWindow, termMatcher } from '../lib/tui-filter';
import { type HitTarget, hitTest, type ScreenMap, zones } from '../lib/tui-hit';
import {
    helpLines,
    hintsFor,
    hintWidth,
    type KeyContext,
    keysToActions,
    type TuiAction,
    wrapHints,
} from '../lib/tui-keys';
import {
    contentSpans,
    type HeadingOf,
    headingLines,
    helpRows,
    lineHeight,
    listWindow,
    MARKED_MARK,
    rowText,
    type Span,
    scrollRows,
    taskRow,
    viewWindow,
} from '../lib/tui-layout';
import { cursorRow, ESC_AGAIN_MS, noteEscape, noteRows, verticalMove } from '../lib/tui-note';
import {
    OPEN_STATES,
    PRESETS,
    presetOf,
    presetRows,
    STATES,
    shownStates,
    stateRows,
    statesGlyphs,
} from '../lib/tui-states';
import {
    crumbParts,
    dependencyLines,
    layerLines,
    revealOptions,
    sessionLines,
    shortTitle,
    type TaskLine,
    type TuiLine,
    treeLines,
} from '../lib/tui-view-model';
import { wikiLinkSpans } from '../lib/wiki-link';
import { type DetailDoc, DetailPane } from './detail-pane';
import { type MouseEvent, mouseParser } from './mouse';
import { type NoteEditor, type NoteState, noteEditor } from './note-editor';
import { type Backdrop, makeTheme, type Style, type Theme } from './theme';

/**
 * The `tsk` TUI: a live view of one `.tsk` file in a terminal — by default
 * beside a Claude Code pane, following that conversation's session. All I/O
 * comes in through {@link TuiIo}, so tests drive it with fakes; the layout
 * rules live in `lib/tui-view-model.ts`. It never writes the file: `m` asks
 * the followed session, which changes it with `tsk`.
 */

export interface Who {
    readonly session: string | undefined;
    /** Shown after the session in the header: the followed Claude's status, or why it's gone. */
    readonly note?: string;
}

export interface TuiIo {
    readonly fileName: string;
    load(): TaskTree;
    /** Call `onChange` whenever the file, or one beside it, may have changed; returns the unsubscribe. */
    watch(onChange: () => void): () => void;
    /** What the last `load` couldn't read beside the file. */
    warnings?(): readonly string[];
    /** Polled: which session to show. */
    who(): Who;
    readonly pollMs: number;
    /** Open the task in an editor; a message on failure. */
    open(node: TreeNode): Promise<string | undefined>;
    /** Draw in colour; false under `NO_COLOR`. Default true. */
    readonly color?: boolean;
    /** The terminal's background, for the selection's tint and light or dark colours. Default dark. */
    readonly backdrop?: Backdrop;
    /** Read a file a task links to, `[[path]]` as written: where it resolved and its text; throws when it can't. */
    readLinked?(path: string): { file: string; text: string };
    /** Call `onChange` whenever that file may have changed; returns the unsubscribe. */
    watchLinked?(path: string, onChange: () => void): () => void;
    /** Open a file at a zero-based line in an editor; a message on failure. */
    openFile?(file: string, line: number): Promise<string | undefined>;
    /** Start with the detail pane shown or hidden; by default, shown in a terminal at least 24 rows tall. */
    readonly detail?: boolean;
    /**
     * Post to the followed Claude session's inbox, calling `onDelivery` as it
     * queues and reads the message; resolves to a function that stops
     * watching, rejects when the post fails. Absent when no Claude is followed.
     */
    tell?(text: string, onDelivery: (d: Delivery) => void): Promise<() => void>;
    /** Ask the terminal to report keys like shift+enter apart from Enter, while a note is typed. */
    extendedKeys?(on: boolean): void;
    /**
     * Take requests from outside to select a task (`tsk show <id> --tui`),
     * each answered by `onSelect`; returns the function that stops taking them.
     */
    requests?(onSelect: (id: string) => SelectReply, onError: (e: Error) => void): () => void;
}

const DARK: Backdrop = { dark: true };
/** How long a message holds the footer before the hints come back. */
export const MESSAGE_MS = 4000;

/** The latest message `m` sent the followed session, in the footer until the session reads it. */
interface Posted {
    readonly subjects: readonly MessageSubject[];
    readonly text: string;
    /** When it was posted, for the footer's clock. */
    readonly at: number;
    readonly state: 'sent' | Delivery;
    /** Stops watching the transcript for it. */
    readonly stop: () => void;
}

/** A message in the footer: a confirmation (green) or an error (red). */
interface Message {
    readonly text: string;
    readonly tone: 'ok' | 'error';
}

type View = 'session' | 'tree' | 'layers' | 'deps';
/** `tab` cycles these; the dependency view is opened on a task with `d` and left with `u`. */
const VIEWS: readonly View[] = ['session', 'tree', 'layers'];
/** The tab strip, in the order `1`–`3` jump to; the dependency view is a drill-down, not a tab. */
const TABS: readonly { view: View; label: string }[] = [
    { view: 'session', label: 'Session' },
    { view: 'tree', label: 'Tree' },
    { view: 'layers', label: 'Steps' },
];
/** A wheel notch scrolls this many lines (in whole rows). */
const WHEEL_LINES = 3;
/** The most rows the note's input grows to; a longer note scrolls to keep the cursor's row in view. */
const NOTE_ROWS = 5;
/** The note's hints, longest first: the footer shows the first that leaves room to type. */
const NOTE_HINTS = ['⏎ send · ⇧⏎ new line · esc cancel ', '⏎ send · esc cancel '];
/** What `space`, `z` and `Z` say outside the tree view, and while it's filtered. */
const FOLD_ELSEWHERE = 'folding works in the tree view: 2';
const FOLD_FILTERED = 'no folding while filtered; esc clears the filter';
/** The `/` filter's prompt, before the query. */
const FILTER_LEAD = ' / ';
/** No terms to highlight. */
const NO_TERMS: readonly string[] = [];
/** Two clicks on one row within this are a double-click — GTK's default; Windows uses 500. */
export const DOUBLE_CLICK_MS = 400;

export function App({ io }: { io: TuiIo }) {
    const { exit } = useApp();
    const { columns, rows } = useWindowSize();
    const width = Math.max(10, columns || 80);
    const height = Math.max(5, rows || 24);
    const backdrop = io.backdrop ?? DARK;
    const theme = useMemo(() => makeTheme(io.color ?? true, backdrop), [io.color, backdrop]);

    const [tree, setTree] = useState(() => io.load());
    const [who, setWho] = useState(() => io.who());
    const [view, setView] = useState<View>('session');
    const [hoist, setHoist] = useState<string>();
    /** The dependency view's task, and the view `u` goes back to. */
    const [depsOf, setDepsOf] = useState<string>();
    const [back, setBack] = useState<View>('session');
    /** The states the tree shows; every one when undefined. */
    const [states, setStates] = useState<ReadonlySet<Marker> | undefined>(OPEN_STATES);
    /**
     * What `a` opens, while it's open: the presets, or the tick list `pick…`
     * opens (what's ticked); where its cursor is.
     */
    const [picking, setPicking] = useState<
        { kind: 'presets'; at: number } | { kind: 'ticks'; ticked: ReadonlySet<Marker>; at: number }
    >();
    /** The tree view's folds, by `@id`: this pane's own, never written to the shared file. */
    const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
    /**
     * The tree view's `/` filter: its query, the prompt's cursor in it, and
     * whether the prompt is open; once Enter keeps it, until Esc.
     */
    const [filter, setFilter] = useState<{ text: string; cursor: number; editing: boolean }>();
    /** What the prompt opens with: the kept query, and what followed `/` in its read, typed after it. */
    const filterSeed = useRef({ kept: '', rest: '' });
    const submitFilter = useRef<(text: string) => void>(() => {});
    const [selectedKey, setSelectedKey] = useState<string>();
    /** The selection is the filter's first match: since the query last changed, until a key moves it. */
    const [seek, setSeek] = useState(false);
    const [cursor, setCursor] = useState(0);
    /** The first row in view; kept by every move so the view only scrolls when it must. */
    const [top, setTop] = useState(0);
    const [message, setMessage] = useState<Message>();
    const say = (text: string) => setMessage({ text, tone: 'ok' });
    const complain = (text: string) => setMessage({ text, tone: 'error' });
    // A new message restarts the clock; a key press clears it sooner.
    useEffect(() => {
        if (!message) return;
        const timer = setTimeout(() => setMessage(undefined), MESSAGE_MS);
        return () => clearTimeout(timer);
    }, [message]);
    /** The view stays where the wheel or a click left it, not following the selection, until a key moves it. */
    const [free, setFree] = useState(false);
    const [help, setHelp] = useState(false);
    /** The `?` overlay's first line in view: it scrolls with the move keys when it doesn't fit. */
    const [helpTop, setHelpTop] = useState(0);
    /** The `p` toggle: undefined until pressed, so the pane follows the terminal's height. */
    const [detailWanted, setDetailWanted] = useState<boolean | undefined>(io.detail);
    /**
     * The pane's share of its axis once resized (`+` / `-`, a drag), undefined
     * for the default: a share, not a size, so it holds when the terminal resizes.
     */
    const [share, setShare] = useState<number>();
    /**
     * The detail pane scrolled away from where it opened: for the task, and at
     * the width, it was scrolled at — the top is a wrapped line, so a resize
     * opens at the task's line again.
     */
    const [scroll, setScroll] = useState<{ key: string; width: number; top: number }>();
    const [doc, setDoc] = useState<DetailDoc>();
    const [posted, setPosted] = useState<Posted>();
    /** The tasks `v` marked for the next message, by id. */
    const [marks, setMarks] = useState<ReadonlySet<string>>(new Set());
    /**
     * The message `m` opens, while it's typed: about which tasks, its lines and
     * cursor (its editor's), and when Esc was pressed once.
     */
    const [note, setNote] = useState<{
        ids: readonly string[];
        lines: readonly string[];
        row: number;
        cursor: number;
        armedAt?: number;
    }>();
    const editor = useRef<NoteEditor>(undefined);
    /** The note's first row in view: it stays put until the cursor's row would leave it. */
    const noteTop = useRef(0);
    /** Where up or down takes the note's cursor, by this render's layout. */
    const noteVertical = useRef<
        (dir: -1 | 1, s: NoteState) => { row: number; cursor: number } | undefined
    >(() => undefined);
    const submitNote = useRef<(line: string) => void>(() => {});
    // "esc again to clear" lasts as long as a second Esc would clear.
    useEffect(() => {
        if (note?.armedAt === undefined) return;
        const timer = setTimeout(
            () => setNote((n) => n && { ...n, armedAt: undefined }),
            ESC_AGAIN_MS,
        );
        return () => clearTimeout(timer);
    }, [note?.armedAt]);
    const postedRef = useRef(posted);
    postedRef.current = posted;
    useEffect(() => () => postedRef.current?.stop(), []);
    // The footer's clock ticks until the session has read it.
    const [, setNow] = useState(0);
    useEffect(() => {
        if (!posted || posted.state === 'read') return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [posted]);

    useEffect(() => {
        /** What couldn't be read beside the file, which the tree goes without. */
        const warn = () => {
            const [warning] = io.warnings?.() ?? [];
            if (warning) setMessage({ text: warning, tone: 'error' });
        };
        warn();
        return io.watch(() => {
            try {
                setTree(io.load());
                warn();
            } catch (e) {
                setMessage({
                    text: `couldn't read ${io.fileName}: ${(e as Error).message}`,
                    tone: 'error',
                });
            }
        });
    }, [io]);
    useEffect(() => {
        const timer = setInterval(() => {
            const next = io.who();
            setWho((prev) =>
                prev.session === next.session && prev.note === next.note ? prev : next,
            );
        }, io.pollMs);
        return () => clearInterval(timer);
    }, [io]);

    const session = who.session;
    const focus = session ? sessionFocus(tree, session) : undefined;
    /**
     * Each `[[file#heading]]`'s heading as it reads, for the rows, the filter
     * and the facts. The linked files are read once per load of the tree; the
     * detail pane's plan is the text it already watches, so a heading renamed
     * there shows at once.
     */
    const headingOf = useMemo<HeadingOf>(() => {
        const headings = new Map<string, readonly MarkdownHeading[]>();
        const read = (link: string) => (doc?.path === link ? doc.text : io.readLinked?.(link).text);
        const nodes = [...tree.nodes, ...(tree.outside?.files.flatMap((f) => f.tree.nodes) ?? [])];
        for (const node of nodes)
            for (const link of wikiLinkSpans(node.task.content)) {
                if (link.fragment === undefined || headings.has(link.path)) continue;
                try {
                    const text = read(link.path);
                    if (text !== undefined) headings.set(link.path, markdownHeadings(text));
                } catch {
                    // Unreadable: the row shows the fragment as written, and the detail pane says why.
                }
            }
        return (link, fragment) => {
            const found = headings.get(link);
            return found && headingFor(found, fragment)?.text;
        };
    }, [io, tree, doc]);
    const query = filter?.text ?? '';
    const terms = useMemo(() => filterTerms(query), [query]);
    const match = useMemo(() => {
        if (terms.length === 0) return undefined;
        const test = termMatcher(terms);
        return (n: TreeNode) => test(rowText(contentSpans(n.task.content, headingOf)), n.id);
    }, [terms, headingOf]);
    const lines = useMemo(() => {
        if (view === 'session') return sessionLines(tree, session);
        if (view === 'layers') return layerLines(tree, focus);
        if (view === 'deps' && depsOf) return dependencyLines(tree, depsOf, focus);
        return treeLines(tree, { hoist, states, focus, folded, match });
    }, [view, tree, session, hoist, states, focus, depsOf, folded, match]);
    const filtering = view === 'tree' && match !== undefined;
    // The breadcrumb stays put above the list while it scrolls.
    const crumbs = lines[0]?.kind === 'crumbs' ? lines[0] : undefined;
    const body = crumbs ? lines.slice(1) : lines;
    const tasks = body.filter((l): l is TaskLine => l.kind === 'task');
    // Stay on the same task across reloads, filters and focus changes; start on the
    // focus; on its nearest ancestor in view while a fold or a filter hides it; at
    // the same position when it has gone. A query just typed selects its first match.
    const firstMatch = seek && filtering ? tasks.findIndex((t) => !t.context) : -1;
    const found =
        firstMatch >= 0
            ? firstMatch
            : selectedKey === undefined
              ? tasks.findIndex((t) => t.focus)
              : shownAt(tasks, tree, selectedKey);
    const index = found >= 0 ? found : Math.min(cursor, Math.max(0, tasks.length - 1));
    const selected = tasks[index];

    // An unknown height (not a terminal) keeps the list alone until `p`.
    // The note's input grows the footer up into the body, a row for each of its screen rows.
    const noteLead = ` message ${session ?? 'the session'}${(note?.ids.length ?? 0) > 1 ? ` about ${note?.ids.length}` : ''} › `;
    // The longest hint that leaves the first row room to type in, else none; Esc's
    // "again to clear" takes its place, so arming doesn't re-wrap the note.
    const noteHint = NOTE_HINTS.find(
        (h) => width - stringWidth(noteLead) - stringWidth(h) - 1 >= 12,
    );
    /** Where the note's row `r` starts on screen: after the prompt, or one column in, as the footer's text is. */
    const noteIndent = (r: number) => (r === 0 ? stringWidth(noteLead) : 1);
    // Each row keeps a column spare at its end, for the cursor after its last character.
    const noteLayout = (lines: readonly string[]) =>
        noteRows(
            lines,
            width - stringWidth(noteLead) - (noteHint ? stringWidth(noteHint) + 1 : 0) - 1,
            width - 2,
        );
    const laidOut = note ? noteLayout(note.lines) : [];
    noteVertical.current = (dir, s) => {
        const to = verticalMove(noteLayout(s.lines), s.lines, s.row, s.cursor, dir, noteIndent);
        return to && { row: to.line, cursor: to.cursor };
    };
    /** The file a task from beside this one is in, which the tree doesn't show. */
    const elsewhere = (node: TreeNode) => outsideFileOf(tree, node);
    /** The marked tasks still in a file, in the order they were marked. */
    const marked = [...marks].filter((id) => lookupId(tree, id) !== undefined);
    const who_ = session
        ? `${session}${who.note ? ` · ${who.note}` : ''}`
        : (who.note ?? 'no session');
    const keyContext: KeyContext = {
        view,
        marker: selected?.node.task.marker,
        zoomed: view === 'tree' && hoist !== undefined,
        folded: view === 'tree' && selected?.node.id !== undefined && folded.has(selected.node.id),
        filtered: view === 'tree' && filter !== undefined,
        canTell: io.tell !== undefined,
        outside: selected !== undefined && elsewhere(selected.node) !== undefined,
        marked: selected?.node.id !== undefined && marks.has(selected.node.id),
        marks: marked.length,
        help,
    };
    // A message the session hasn't read yet shows on the right, before the session.
    const askNote =
        posted && posted.state !== 'read'
            ? `→ ${posted.subjects[0]?.id}${posted.subjects.length > 1 ? ` +${posted.subjects.length - 1}` : ''} ${posted.state} ${elapsed(Date.now() - posted.at)}`
            : undefined;
    // The marks, then a message the session hasn't read, then the session.
    const lead = [
        ...(marked.length > 0 ? [`${MARKED_MARK} ${marked.length}`] : []),
        ...(askNote ? [askNote] : []),
    ].join(' · ');
    const rights = lead ? [`${lead} · ${who_} `, `${lead} `] : [`${who_} `];
    // The hints wrap onto more rows; the first leaves room for the shortest right, so a
    // narrow pane still says which session it follows.
    const hintRows = wrapHints(
        hintsFor(keyContext),
        width,
        width - stringWidth(rights.at(-1) ?? ''),
    );
    /** The presets or the tick list, in place of the hints while it's open. */
    const statesRows = picking
        ? picking.kind === 'presets'
            ? presetRows(picking.at, width)
            : stateRows(picking.ticked, picking.at, width)
        : undefined;
    const noteHeight = note ? Math.min(laidOut.length, NOTE_ROWS) : 1;
    // The rows of what the footer shows: the note, the filter's prompt or a message take
    // the hints' place, as `shownRows` picks.
    const footerHeight = note
        ? noteHeight
        : filter?.editing || message
          ? 1
          : (statesRows?.length ?? hintRows.length);
    const bodyRows = height - 2 - footerHeight;
    const splitAt = (s: number | undefined) =>
        splitPane(width, bodyRows, rows > 0 ? rows : 0, detailWanted, s);
    const split = splitAt(share);
    const listWidth = split.listWidth;
    const listHeight = split.listRows - (crumbs ? 1 : 0);
    const shownTerms = filtering ? terms : NO_TERMS;
    const heights = useMemo(
        () => body.map((l) => lineHeight(l, listWidth, shownTerms, headingOf)),
        [body, listWidth, shownTerms, headingOf],
    );
    const win = free
        ? viewWindow(heights, top, listHeight)
        : listWindow(heights, selected ? body.indexOf(selected) : 0, top, listHeight);
    const backdropNote = `background  ${backdrop.background ?? 'not reported'}, ${backdrop.dark ? 'dark' : 'light'}`;
    // One screen row each, so j/k scroll the overlay a row at a time.
    const helpShown = helpRows([...helpLines(), { kind: 'note', text: backdropNote }], listWidth);
    const helpOnes = helpShown.map(() => 1);
    const helpWin = listWindow(helpOnes, helpTop, helpTop, listHeight, 0);
    const helpMaxTop = listWindow(helpOnes, helpShown.length, helpShown.length, listHeight, 0).top;

    // The detail pane: the selected task's facts, then its plan at the line naming it.
    const selKey = selected ? selectionKey(selected.node) : '';
    const linkPath = selected && split.shown ? linkedFile(selected.node)?.path : undefined;
    useEffect(() => {
        if (!linkPath || !io.readLinked) {
            setDoc(undefined);
            return;
        }
        const read = io.readLinked;
        const load = () => {
            try {
                setDoc({ path: linkPath, ...read(linkPath) });
            } catch (e) {
                setDoc({ path: linkPath, error: (e as Error).message });
            }
        };
        load();
        return io.watchLinked?.(linkPath, load);
    }, [io, linkPath]);
    const paneWidth = split.side ? split.detailWidth - 1 : split.detailWidth;
    const facts = useMemo(
        () =>
            selected && split.shown
                ? factLines(taskFacts(tree, selected.node), paneWidth, headingOf)
                : [],
        [tree, selected, split.shown, paneWidth, headingOf],
    );
    const shownDoc = doc && doc.path === linkPath ? doc : undefined;
    const docLines = useMemo(
        () =>
            shownDoc?.text !== undefined && split.shown
                ? markdownLines(shownDoc.text, paneWidth, selected?.node.id)
                : [],
        [shownDoc, paneWidth, split.shown, selected],
    );
    const named =
        shownDoc?.text !== undefined && selected
            ? namedLine(shownDoc.text, selected.node)
            : undefined;
    const anchorTop = named === undefined ? 0 : anchorIndex(docLines, named);
    const pane = detailWindow(
        split.detailRows,
        facts.length,
        docLines.length,
        scroll?.key === selKey && scroll.width === paneWidth ? scroll.top : anchorTop,
    );
    /** Lines of the file the pane shows at once, for a page. */
    const fileRows = Math.max(1, pane.fileRows);
    /**
     * The pane's top and split as this read's keys leave them: several keys
     * arrive in one read and act on one render, so `JJo` must see both `J`s,
     * and `++` grow twice.
     */
    const live = { top: pane.top, split };
    const scrollBy = (n: number) => {
        live.top = Math.max(0, Math.min(live.top + n, docLines.length - fileRows));
        setScroll({ key: selKey, width: paneWidth, top: live.top });
    };
    const resize = (next: number | undefined) => {
        live.split = splitAt(next);
        setShare(next);
    };

    /** The selection stays on this task, whatever the filter's first match. */
    const pin = (key: string | undefined) => {
        setSelectedKey(key);
        setSeek(false);
    };
    /** The selection to task `i`; a key brings it into view, a click leaves the view where it is. */
    const moveTo = (i: number, follow = true) => {
        const clamped = Math.max(0, Math.min(i, tasks.length - 1));
        setCursor(clamped);
        setTop(win.top);
        // Another task opens the pane at its own line again.
        setScroll(undefined);
        setFree(!follow);
        const next = tasks[clamped];
        pin(next ? selectionKey(next.node) : undefined);
    };
    /** Drop the filter; the selection stays on `node`, or goes back to where it was before the query. */
    const clearFilter = (node?: TreeNode) => {
        if (seek && node) setSelectedKey(selectionKey(node));
        setSeek(false);
        setFilter(undefined);
        setFree(false);
    };
    /** A new list: start at its top, following the selection. */
    const resetView = () => {
        setTop(0);
        setFree(false);
    };
    // Functional updates: several keys in one read act on one stale render.
    const showView = (v: View | ((from: View) => View)) => {
        setView(v);
        setHoist(undefined);
        resetView();
    };
    const zoomTo = (id: string) => {
        setView('tree');
        setHoist(id);
        resetView();
    };
    /**
     * Asked from outside to select `id`: here when this view shows it, else in
     * the tree with whatever hides it there set aside. Never while the user
     * is typing, so nothing moves under them.
     */
    const selectAsked = (id: string): SelectReply => {
        if (note) return { ok: false, why: 'busy: a note is being typed' };
        if (filter?.editing) return { ok: false, why: 'busy: a filter is being typed' };
        if (picking) return { ok: false, why: 'busy: the list of states is open' };
        const node = tree.byId.get(id);
        if (!node) return { ok: false, why: `no task ${id} in ${io.fileName}` };
        if (!tasks.some((t) => t.node === node)) {
            const shown = revealOptions(tree, node, { hoist, states, folded, match });
            setView('tree');
            setHoist(shown.hoist);
            setFolded(shown.folded ?? folded);
            setStates(shown.states);
            if (match && !shown.match) setFilter(undefined);
            resetView();
        }
        setHelp(false);
        setScroll(undefined);
        setFree(false);
        pin(selectionKey(node));
        say(`tsk:${id} selected, asked from outside`);
        return { ok: true };
    };
    const answerAsked = useRef(selectAsked);
    answerAsked.current = selectAsked;
    useEffect(
        () =>
            io.requests?.(
                (id) => answerAsked.current(id),
                (e) => setMessage({ text: `requests from outside: ${e.message}`, tone: 'error' }),
            ),
        [io],
    );
    /**
     * Post what was typed at `m` about these tasks; it takes the place of the
     * last message in the footer, and the marks go once it's sent.
     */
    const send = async (
        about: readonly { node: TreeNode; id: string }[],
        tell: NonNullable<TuiIo['tell']>,
        said: string,
    ) => {
        const to = session ?? 'the session';
        const subjects = about.map(({ node, id }) => {
            const file = elsewhere(node);
            return {
                id,
                title: shortTitle(node.task.content),
                file: file ? path.basename(file) : io.fileName,
            };
        });
        const ids = subjects.map((s) => s.id).join(', ');
        const text = messageText(subjects, said);
        try {
            const onDelivery = (d: Delivery) => {
                setPosted((p) => (p?.text === text ? { ...p, state: d } : p));
                if (d === 'read') say(`${to} has read the message about ${ids}`);
                if (d === 'removed') {
                    setPosted((p) => (p?.text === text ? undefined : p));
                    complain(`${to} dropped the message about ${ids} unread`);
                }
            };
            const stop = await tell(text, onDelivery);
            postedRef.current?.stop();
            setPosted({ subjects, text, at: Date.now(), state: 'sent', stop });
            setMarks(new Set());
            say(`sent ${to} the message about ${ids}`);
        } catch (e) {
            complain(`couldn't message ${to}: ${(e as Error).message}`);
        }
    };

    const act = (action: TuiAction, at: number): number => {
        const node = tasks[at]?.node;
        const id = node?.id;
        if (
            help &&
            (action === 'down' || action === 'up' || action === 'top' || action === 'bottom')
        ) {
            const to = { down: 1, up: -1, top: -Infinity, bottom: Infinity }[action];
            setHelpTop((t) => Math.max(0, Math.min(helpMaxTop, t + to)));
            return at;
        }
        if (help && action === 'escape') {
            setHelp(false);
            return at;
        }
        switch (action) {
            case 'down':
                return at + 1;
            case 'up':
                return at - 1;
            case 'top':
                return 0;
            case 'bottom':
                return tasks.length - 1;
            case 'quit':
                exit();
                return at;
            case 'help':
                setHelp((h) => !h);
                setHelpTop(0);
                return at;
            case 'switchView':
                showView((v) => nextView(v, 1));
                return at;
            case 'prevView':
                showView((v) => nextView(v, -1));
                return at;
            case 'sessionView':
                showView('session');
                return at;
            case 'treeView':
                showView('tree');
                return at;
            case 'stepsView':
                showView('layers');
                return at;
            case 'deps':
                if (id) {
                    if (view !== 'deps') setBack(view);
                    setView('deps');
                    setDepsOf(id);
                    pin(id);
                    resetView();
                } else complain(node ? 'that task has no @id' : 'nothing selected');
                return at;
            case 'zoomIn':
                if (node && elsewhere(node))
                    complain(
                        `${node.id} is in ${path.basename(elsewhere(node) ?? '')}: the tree shows ${io.fileName} only`,
                    );
                else if (id) zoomTo(id);
                return at;
            case 'escape':
                if (marks.size > 0) {
                    setMarks(new Set());
                    return at;
                }
                if (view === 'tree' && filter) {
                    clearFilter(node);
                    return at;
                }
                return act('zoomOut', at);
            case 'zoomOut':
                if (view === 'deps') showView(back);
                else if (view === 'tree' && hoist) {
                    setHoist(tree.byId.get(hoist)?.parent?.id);
                    resetView();
                }
                return at;
            case 'states':
                if (view !== 'tree') showView('tree');
                setPicking({ kind: 'presets', at: presetOf(states) });
                return at;
            case 'filter':
                if (view !== 'tree') showView('tree');
                filterSeed.current = { kept: filter?.text ?? '', rest: '' };
                setFilter({ text: filterSeed.current.kept, cursor: 0, editing: true });
                return at;
            case 'fold': {
                if (view !== 'tree' || filtering) {
                    complain(filtering ? FOLD_FILTERED : FOLD_ELSEWHERE);
                    return at;
                }
                if (!node) {
                    complain('nothing selected');
                    return at;
                }
                if (id && folded.has(id)) {
                    setFolded((f) => new Set([...f].filter((k) => k !== id)));
                    return at;
                }
                // With nothing under it in view, its parent folds, and takes the selection.
                const target = tasks[at + 1]?.node.parent === node ? node : node.parent;
                const targetAt = tasks.findIndex((t) => t.node === target);
                const targetId = target?.id;
                if (targetAt < 0) complain('nothing to fold');
                else if (!targetId) complain('that task has no @id');
                else {
                    setFolded((f) => new Set(f).add(targetId));
                    return targetAt;
                }
                return at;
            }
            case 'foldAll':
            case 'unfoldAll':
                if (view !== 'tree') complain(FOLD_ELSEWHERE);
                else if (filtering) complain(FOLD_FILTERED);
                else if (action === 'unfoldAll') setFolded(new Set());
                else
                    setFolded(
                        new Set(
                            tree.nodes.flatMap((n) =>
                                n.id && n.children.length > 0 ? [n.id] : [],
                            ),
                        ),
                    );
                return at;
            case 'detail':
                setDetailWanted((w) => !(w ?? split.shown));
                return at;
            case 'detailDown':
            case 'detailUp':
            case 'detailPageDown':
            case 'detailPageUp': {
                if (!split.shown) {
                    complain('p shows the detail pane');
                    return at;
                }
                const page = Math.max(1, fileRows - 1);
                scrollBy(
                    { detailDown: 1, detailUp: -1, detailPageDown: page, detailPageUp: -page }[
                        action
                    ],
                );
                return at;
            }
            case 'detailGrow':
            case 'detailShrink':
            case 'detailReset':
                if (!split.shown) complain('p shows the detail pane');
                else if (action === 'detailReset') resize(undefined);
                else
                    resize(
                        stepShare(live.split, width, bodyRows, action === 'detailGrow' ? 1 : -1),
                    );
                return at;
            case 'openFile': {
                const file = shownDoc?.file;
                if (!file || !io.openFile) {
                    complain(shownDoc?.error ?? 'no plan linked to open');
                    return at;
                }
                // The line the pane's rule names: the first in view that a block starts on.
                const line =
                    docLines.slice(live.top).find((l) => l.source !== undefined)?.source ?? 0;
                io.openFile(file, line).then((err) =>
                    err ? complain(err) : say(`opened ${shownDoc.path}:${line + 1} in VS Code`),
                );
                return at;
            }
            case 'message':
                if (!io.tell)
                    complain('m messages a followed Claude: open the pane with --follow-pid');
                else if (marked.length > 0)
                    setNote({ ids: marked, lines: [''], row: 0, cursor: 0 });
                else if (!id) complain(node ? 'that task has no @id' : 'nothing selected');
                else setNote({ ids: [id], lines: [''], row: 0, cursor: 0 });
                return at;
            case 'mark':
                if (!id) complain(node ? 'that task has no @id' : 'nothing selected');
                else
                    setMarks((m) => {
                        const next = new Set(m);
                        if (!next.delete(id)) next.add(id);
                        return next;
                    });
                return at;
            case 'open': {
                if (!node) return at;
                const file = elsewhere(node);
                const opened = file
                    ? (io.openFile?.(file, node.task.line) ??
                      Promise.resolve('no editor to open it in'))
                    : io.open(node);
                opened.then((err) =>
                    err ? complain(err) : say(`opened ${node.id ?? 'line'} in VS Code`),
                );
                return at;
            }
        }
    };

    submitNote.current = (text) => {
        const ids = note?.ids ?? [];
        setNote(undefined);
        // A task gone from the file while the message was typed is left out.
        const about = ids.flatMap((id) => {
            const node = lookupId(tree, id);
            return node ? [{ node, id }] : [];
        });
        if (!text.trim()) say('not sent');
        else if (about.length > 0 && io.tell) void send(about, io.tell, text);
    };
    /** Esc on the note: cancel it when empty, else clear it on a second press (Claude Code's prompt). */
    const escapeNote = () => {
        if (!note) return;
        const now = Date.now();
        const what = noteEscape(note.lines.join('\n'), note.armedAt, now);
        if (what === 'cancel') {
            setNote(undefined);
            say('not sent');
        } else if (what === 'clear') {
            editor.current?.clear();
            setNote((n) => n && { ...n, armedAt: undefined });
        } else setNote((n) => n && { ...n, armedAt: now });
    };

    submitFilter.current = (text) => {
        // An empty query keeps nothing.
        if (filterTerms(text).length === 0) clearFilter();
        else {
            setFilter({ text, cursor: text.length, editing: false });
            // Typed and sent in one read, it never showed: select its first match now.
            if (text !== filter?.text) setSeek(true);
        }
    };

    useInput((input, key) => {
        // While the note is open its keys are its editor's (fed from stdin below); only Esc is ours.
        if (note) {
            if (key.escape) escapeNote();
            return;
        }
        // So with the presets: h and l move, a preset's letter or Enter picks, Esc leaves it as it was.
        if (picking?.kind === 'presets') {
            setMessage(undefined);
            if (key.escape) {
                setPicking(undefined);
                return;
            }
            let { at } = picking;
            let chosen = key.return ? at : undefined;
            if (key.leftArrow) at--;
            else if (key.rightArrow) at++;
            else
                for (const ch of input) {
                    if (ch === 'h') at--;
                    else if (ch === 'l') at++;
                    else {
                        const i = ch === '\r' ? at : PRESETS.findIndex((p) => p.key === ch);
                        if (i >= 0) chosen = i;
                    }
                    if (chosen !== undefined) break;
                }
            at = Math.max(0, Math.min(at, PRESETS.length - 1));
            const preset = chosen === undefined ? undefined : PRESETS[chosen];
            if (!preset) setPicking({ kind: 'presets', at });
            else if ('pick' in preset)
                setPicking({ kind: 'ticks', ticked: states ?? new Set(STATES), at: 0 });
            else {
                setPicking(undefined);
                setStates(preset.states);
            }
            return;
        }
        // So with the tick list: h and l move, space ticks, Enter keeps, Esc leaves it as it was.
        if (picking) {
            setMessage(undefined);
            if (key.escape) {
                setPicking(undefined);
                return;
            }
            let { at } = picking;
            const ticked = new Set(picking.ticked);
            let keep = key.return;
            if (key.leftArrow) at--;
            else if (key.rightArrow) at++;
            else
                for (const ch of input) {
                    if (ch === 'h') at--;
                    else if (ch === 'l') at++;
                    else if (ch === '\r') keep = true;
                    else if (ch === ' ') {
                        const state = STATES[Math.max(0, Math.min(at, STATES.length - 1))];
                        if (state && !ticked.delete(state)) ticked.add(state);
                    }
                }
            at = Math.max(0, Math.min(at, STATES.length - 1));
            if (!keep) setPicking({ kind: 'ticks', ticked, at });
            else if (ticked.size === 0) {
                setPicking({ kind: 'ticks', ticked, at });
                complain('tick a state to show');
            } else {
                setPicking(undefined);
                setStates(shownStates(ticked));
            }
            return;
        }
        // So with the filter's prompt, where Esc clears the filter and up and down move the selection.
        if (filter?.editing) {
            if (key.escape) clearFilter();
            else if (key.upArrow || key.downArrow) moveTo(index + (key.upArrow ? -1 : 1));
            return;
        }
        const actions = keysToActions(input, key);
        if (actions.length === 0) return;
        setMessage(undefined);
        let at = index;
        for (const a of actions) {
            at = act(a, at);
            // What follows m in the same read was meant for the message, not the key table: drop it.
            if (a === 'message') break;
            // What follows `/` is the query's start (a paste, tmux's send-keys): the prompt reads it.
            if (a === 'filter') {
                filterSeed.current.rest = input.slice(input.indexOf('/') + 1);
                break;
            }
        }
        if (at !== index) moveTo(at);
    });

    // The mouse reads the chunks Ink reads (see mouse.ts); `onMouse` is this render's handler.
    const { stdin } = useStdin();
    const onMouse = useRef<(events: readonly MouseEvent[]) => void>(() => {});
    const lastClick = useRef<{ row: number; at: number }>(undefined);
    /** A left press landed on the detail pane's edge: drags move it until the release. */
    const dragging = useRef(false);
    // While the note is open, the chunks Ink reads go to its editor too.
    const noting = note?.ids.join(' ');
    useEffect(() => {
        if (noting === undefined) return;
        const ed = noteEditor({
            onChange: ({ lines, row, cursor }) => setNote((n) => n && { ...n, lines, row, cursor }),
            onSubmit: (text) => submitNote.current(text),
            onEnd: () => setNote(undefined),
            vertical: (dir, s) => noteVertical.current(dir, s),
        });
        editor.current = ed;
        const onData = (data: Buffer | string) => ed.feed(data.toString());
        stdin.on('data', onData);
        io.extendedKeys?.(true);
        return () => {
            io.extendedKeys?.(false);
            stdin.off('data', onData);
            ed.close();
            editor.current = undefined;
        };
    }, [noting, stdin, io]);
    // The filter's prompt is the note's editor on one line: Enter keeps the query, and
    // each change selects the first match.
    const typingFilter = filter?.editing === true;
    useEffect(() => {
        if (!typingFilter) return;
        const { kept, rest } = filterSeed.current;
        let typed = kept;
        const ed = noteEditor({
            singleLine: true,
            onChange: ({ lines, cursor }) => {
                const text = lines[0] ?? '';
                setFilter((f) => f && { ...f, text, cursor });
                if (text === typed) return;
                typed = text;
                setSeek(true);
                setFree(false);
            },
            onSubmit: (text) => submitFilter.current(text),
            onEnd: () => submitFilter.current(''),
        });
        const onData = (data: Buffer | string) => ed.feed(data.toString());
        stdin.on('data', onData);
        ed.feed(kept);
        ed.feed(rest);
        return () => {
            stdin.off('data', onData);
            ed.close();
        };
    }, [typingFilter, stdin]);
    // Bracketed paste while the note or the prompt is open: Ink keeps a paste out of
    // `useInput`, and the editor reads its line breaks as new lines (or spaces) rather
    // than an Enter that sends.
    usePaste(() => {}, { isActive: noting !== undefined || typingFilter });
    useEffect(() => {
        const parse = mouseParser();
        const onData = (data: Buffer | string) => {
            const events = parse(data.toString());
            if (events.length > 0) onMouse.current(events);
        };
        stdin.on('data', onData);
        return () => {
            stdin.off('data', onData);
        };
    }, [stdin]);

    const position = tasks.length > 0 ? `${index + 1}/${tasks.length}` : '';
    const depsSubject = depsOf ? tree.byId.get(depsOf) : undefined;
    const flags = [
        view === 'tree' && hoist ? 'zoomed' : undefined,
        view === 'tree' && states ? statesGlyphs(states) : undefined,
        view === 'tree' && filter && !filter.editing ? `/${filter.text}` : undefined,
    ].filter(Boolean);
    const tabs: Piece[] =
        view === 'deps'
            ? [
                  {
                      text: ` deps of ${depsSubject ? shortTitle(depsSubject.task.content) : depsOf} `,
                      style: theme.activeTab,
                  },
                  { text: '  ', style: {} },
                  { text: 'esc back', style: theme.dim, target: { kind: 'back' } },
              ]
            : [
                  ...TABS.map(({ view: v, label }, index) => ({
                      text: ` ${label} `,
                      style: v === view ? theme.activeTab : theme.tab,
                      target: { kind: 'tab', index } as const,
                  })),
                  ...(flags.length > 0
                      ? [{ text: ` · ${flags.join(' · ')}`, style: theme.dim }]
                      : []),
              ];
    const strip = spread(
        [{ text: ' tsk ', style: theme.name }, ...tabs],
        [`${io.fileName}  ${position} `, `${position} `].map((text) => ({
            text,
            style: theme.dim,
        })),
        width,
    );
    /** The note's rows, and where its cursor is among them: the terminal's own cursor goes there. */
    let noteBar: Piece[][] | undefined;
    let noteCursor: { x: number; y: number } | undefined;
    if (note) {
        const at = cursorRow(laidOut, note.row, note.cursor);
        const top = Math.max(
            0,
            Math.min(at, laidOut.length - NOTE_ROWS, Math.max(noteTop.current, at - NOTE_ROWS + 1)),
        );
        noteTop.current = top;
        const hint = noteHint && (note.armedAt !== undefined ? 'esc again to clear ' : noteHint);
        noteBar = laidOut.slice(top, top + NOTE_ROWS).map((row, i) => {
            const r = top + i;
            const line = note.lines[row.line] ?? '';
            const typed: Piece[] = [
                { text: r === 0 ? noteLead : ' ', style: theme.dim },
                { text: line.slice(row.start, row.end), style: {} },
            ];
            if (r === at) {
                const x = noteIndent(r) + stringWidth(line.slice(row.start, note.cursor));
                noteCursor = { x, y: height - noteHeight + i };
            }
            return r === 0 && hint
                ? spread(typed, [{ text: hint, style: theme.dim }], width)
                : typed;
        });
    }
    /** The filter's prompt, scrolled to keep its cursor in view, with how many match on the right. */
    let filterBar: Piece[] | undefined;
    let filterCursor: { x: number; y: number } | undefined;
    if (filter?.editing) {
        const n = match ? tasks.filter((t) => !t.context).length : undefined;
        const tally =
            n === undefined ? '' : n === 0 ? 'no match' : `${n} match${n === 1 ? '' : 'es'}`;
        const lead = stringWidth(FILTER_LEAD);
        const hint =
            [[tally, '↑↓ move · ⏎ keep · esc clear'], [tally, '⏎ keep · esc clear'], [tally]]
                .map((parts) => parts.filter(Boolean).join(' · '))
                .map((h) => (h ? `${h} ` : ''))
                .find((h) => width - lead - stringWidth(h) - 1 >= 12) ?? '';
        const room = width - lead - (hint ? stringWidth(hint) + 1 : 0);
        const shown = inputWindow(filter.text, filter.cursor, room);
        filterBar = spread(
            [
                { text: FILTER_LEAD, style: theme.key },
                { text: filter.text.slice(shown.start, shown.end), style: {} },
            ],
            [{ text: hint, style: theme.dim }],
            width,
        );
        const x = lead + stringWidth(filter.text.slice(shown.start, filter.cursor));
        filterCursor = { x, y: height - 1 };
    }
    const statesBar: Piece[][] | undefined = statesRows?.map((row) =>
        row.map((p) => ({
            text: p.text,
            style:
                p.tone === 'lead' || p.tone === 'key'
                    ? theme.key
                    : p.tone === 'current'
                      ? theme.cursor
                      : p.tone === 'hint'
                        ? theme.dim
                        : {},
        })),
    );
    // The terminal's own cursor, in its own shape, while a note or a query is typed; hidden otherwise.
    const { setCursorPosition } = useCursor();
    setCursorPosition(noteCursor ?? filterCursor);
    const hintBar = hintRows.map((row, i) => {
        const pieces = row.flatMap((h) => [
            { text: ` ${h.keys}`, style: theme.key },
            { text: ` ${h.label} `, style: {} },
        ]);
        return i === 0
            ? spread(
                  pieces,
                  rights.map((text) => ({ text, style: theme.dim })),
                  width,
              )
            : pieces;
    });
    const messageBar: Piece[] | undefined = message && [
        { text: ` ${message.text}`, style: message.tone === 'ok' ? theme.ok : theme.error },
    ];
    // A message shows over the list of states (why Enter was refused) until the next key.
    const footerRows =
        noteBar ?? (filterBar ? [filterBar] : messageBar ? [messageBar] : (statesBar ?? hintBar));
    const crumbBits = crumbs
        ? crumbParts(
              crumbs.path.map((n) => shortTitle(n.task.content)),
              listWidth,
          )
        : undefined;

    /** Where things are on screen, for the mouse: the same parts and heights drawn below. */
    const screen: ScreenMap = {
        strip: zones(strip),
        crumbs: crumbBits
            ? zones(
                  crumbBits.map((p) => ({
                      text: p.text,
                      target:
                          p.index === undefined
                              ? undefined
                              : ({ kind: 'crumb', index: p.index } as const),
                  })),
              )
            : undefined,
        listTop: crumbs ? 3 : 2,
        listHeight,
        window: help ? undefined : win,
        heights,
        footerY: height - footerHeight,
        divider: split.shown
            ? { side: split.side, at: split.side ? listWidth : 2 + split.listRows }
            : undefined,
    };
    const scrollList = (lines: number) => {
        setTop(viewWindow(heights, scrollRows(heights, win.top, lines), listHeight).top);
        setFree(true);
    };
    /** Where the detail pane is: right of the list side by side, below it stacked. */
    const inDetail = (x: number, y: number) =>
        split.shown && (split.side ? x >= listWidth : y >= 2 + split.listRows && y < height - 1);
    const click = (target: HitTarget | undefined) => {
        switch (target?.kind) {
            case 'tab':
                showView(TABS[target.index]?.view ?? 'session');
                break;
            case 'back':
                act('zoomOut', index);
                break;
            case 'crumb': {
                const id = crumbs?.path[target.index]?.id;
                if (id) zoomTo(id);
                break;
            }
            case 'more':
                scrollList(target.direction * Math.max(1, listHeight - 2));
                break;
            case 'row': {
                const line = body[target.index];
                const at = line?.kind === 'task' ? tasks.indexOf(line) : -1;
                if (at < 0) break;
                const now = Date.now();
                const last = lastClick.current;
                if (last && last.row === target.index && now - last.at <= DOUBLE_CLICK_MS) {
                    lastClick.current = undefined;
                    act('zoomIn', at);
                } else {
                    lastClick.current = { row: target.index, at: now };
                    moveTo(at, false);
                }
                break;
            }
            case 'footer': {
                if (message) break;
                let x = 0;
                for (const h of hintRows[target.row] ?? []) {
                    x += hintWidth(h);
                    if (target.x < x) {
                        const to = act(h.action, index);
                        if (to !== index) moveTo(to);
                        break;
                    }
                }
                break;
            }
            // 'list' is empty space.
        }
    };
    onMouse.current = (events: readonly MouseEvent[]) => {
        let lines = 0;
        let detailLines = 0;
        for (const e of events) {
            if (e.kind === 'wheel') {
                if (inDetail(e.x, e.y)) detailLines += e.button * WHEEL_LINES;
                else lines += e.button * WHEEL_LINES;
            } else if (e.button !== 0 || note || typingFilter || picking) {
                // Only the left button clicks and drags, and not while a note or a query is typed.
            } else if (e.kind === 'press') {
                const target = hitTest(screen, e.x, e.y);
                dragging.current = target?.kind === 'divider';
                if (dragging.current || inDetail(e.x, e.y)) continue;
                setMessage(undefined);
                click(target);
            } else if (e.kind === 'drag') {
                // The edge follows the pointer: the rule onto its line, the border onto its column.
                if (dragging.current && split.shown)
                    resize(shareAt(split.side, width, bodyRows, e.x, e.y - 2));
            } else dragging.current = false;
        }
        if (lines !== 0 && !help) scrollList(lines);
        if (detailLines !== 0) scrollBy(detailLines);
    };

    return (
        <Box flexDirection="column" width={width} height={height}>
            <Text wrap="truncate-end">
                <Pieces pieces={strip} />
            </Text>
            <Text {...theme.rule}>{'━'.repeat(width)}</Text>
            <Box flexDirection={split.side ? 'row' : 'column'} height={bodyRows}>
                <Box flexDirection="column" width={listWidth}>
                    {crumbBits ? (
                        <Text {...theme.dim}>{crumbBits.map((p) => p.text).join('')}</Text>
                    ) : null}
                    <Box flexDirection="column" height={listHeight} overflow="hidden">
                        {help ? (
                            <>
                                {helpWin.above > 0 ? (
                                    <More theme={theme} text={`↑ ${helpWin.above} more`} />
                                ) : null}
                                {helpShown.slice(helpWin.top, helpWin.end).map((h) => (
                                    <Text
                                        key={h.id}
                                        {...(h.kind === 'key' ? {} : theme.dim)}
                                        wrap="truncate-end"
                                    >
                                        <Text {...theme.key}>{h.keys}</Text>
                                        {h.text}
                                    </Text>
                                ))}
                                {helpWin.below > 0 ? (
                                    <More theme={theme} text={`↓ ${helpWin.below} more · j/k`} />
                                ) : null}
                            </>
                        ) : (
                            <>
                                {win.above > 0 ? (
                                    <More theme={theme} text={`↑ ${win.above} more`} />
                                ) : null}
                                {body.slice(win.top, win.end).map((line) => (
                                    <Line
                                        key={lineKey(line)}
                                        line={line}
                                        width={listWidth}
                                        selected={line === selected}
                                        marked={
                                            line.kind === 'task' &&
                                            line.node.id !== undefined &&
                                            marks.has(line.node.id)
                                        }
                                        terms={shownTerms}
                                        headingOf={headingOf}
                                        theme={theme}
                                    />
                                ))}
                                {win.below > 0 ? (
                                    <More theme={theme} text={`↓ ${win.below} more`} />
                                ) : null}
                            </>
                        )}
                    </Box>
                </Box>
                {split.shown ? (
                    <DetailPane
                        theme={theme}
                        width={split.detailWidth}
                        rows={split.detailRows}
                        marker={selected?.node.task.marker}
                        facts={facts}
                        doc={shownDoc ?? (linkPath ? { path: linkPath } : undefined)}
                        lines={docLines}
                        top={pane.top}
                        border={split.side}
                    />
                ) : null}
            </Box>
            <Box flexDirection="column" width={width} backgroundColor={theme.bar.backgroundColor}>
                {footerRows.map((pieces, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the footer's rows are redrawn whole.
                    <Text key={i} wrap="truncate-end">
                        <Pieces pieces={pieces} />
                    </Text>
                ))}
            </Box>
        </Box>
    );
}

/** A piece of the tab strip or the footer bar, and what a click on it does. */
interface Piece {
    readonly text: string;
    readonly style: Style;
    readonly target?: HitTarget;
}

const piecesWidth = (pieces: readonly Piece[]) =>
    pieces.reduce((w, p) => w + stringWidth(p.text), 0);

/** `left`, then the first of `rights` that still fits, against the right edge. */
function spread(left: readonly Piece[], rights: readonly Piece[], width: number): Piece[] {
    const used = piecesWidth(left);
    const right = rights.find((r) => used + stringWidth(r.text) <= width);
    if (!right) return [...left];
    return [
        ...left,
        { text: ' '.repeat(width - used - stringWidth(right.text)), style: {} },
        right,
    ];
}

/** Styled pieces of one line, keyed by where each starts. */
function Pieces({ pieces }: { pieces: readonly Piece[] }) {
    let at = 0;
    return pieces
        .filter((p) => p.text !== '')
        .map((p) => {
            const key = at;
            at += p.text.length;
            return (
                <Text key={key} {...p.style}>
                    {p.text}
                </Text>
            );
        });
}

/** The view `step` away in the `tab` order; from the dependency view, the first or the last. */
function nextView(v: View, step: 1 | -1): View {
    const i = VIEWS.indexOf(v);
    if (i < 0) return (step > 0 ? VIEWS[0] : VIEWS.at(-1)) ?? 'session';
    return VIEWS[(i + step + VIEWS.length) % VIEWS.length] ?? 'session';
}

/** What the selection remembers: the `@id`, or the line for a task without one. */
function selectionKey(node: TreeNode): string {
    return node.id ?? `line:${node.task.line}`;
}

/**
 * Where the task `key` names is among `tasks`; while a fold or a filter hides
 * it, where its nearest ancestor in view is; -1 once it has gone from the file.
 */
function shownAt(tasks: readonly TaskLine[], tree: TaskTree, key: string): number {
    const at = tasks.findIndex((t) => selectionKey(t.node) === key);
    if (at >= 0) return at;
    const node = tree.byId.get(key) ?? tree.nodes.find((n) => selectionKey(n) === key);
    for (let up = node?.parent; up; up = up.parent) {
        const i = tasks.findIndex((t) => t.node === up);
        if (i >= 0) return i;
    }
    return -1;
}

/** A stable React key: a task by its line, a heading by its text (each appears once). */
function lineKey(line: TuiLine): string {
    if (line.kind === 'task') return `task:${line.node.task.line}`;
    return line.kind === 'heading' ? `heading:${line.text}` : 'crumbs';
}

function More({ theme, text }: { theme: Theme; text: string }) {
    return <Text {...theme.dim}>{`  ${text}`}</Text>;
}

function Line({
    line,
    width,
    selected,
    marked,
    terms,
    headingOf,
    theme,
}: {
    line: TuiLine;
    width: number;
    selected: boolean;
    /** Marked for the next message: `●` in its gutter. */
    marked: boolean;
    /** The filter's, highlighted in a matching task's text. */
    terms: readonly string[];
    headingOf: HeadingOf;
    theme: Theme;
}) {
    if (line.kind === 'heading') {
        return (
            <Box flexDirection="column">
                {headingLines(line.text, width).map((l) => (
                    <Text key={l} {...theme.dim}>
                        {l}
                    </Text>
                ))}
            </Box>
        );
    }
    if (line.kind === 'crumbs') return null;
    const row = taskRow(line, width, terms, headingOf, marked);
    const marker = line.node.task.marker;
    /** Laid over every piece of the selected row: undimmed and bold on the tint, or inverse. */
    const over: Style = selected ? theme.selected : {};
    /** A row the filter shows only for what's under it recedes. */
    const context: Style = line.context ? theme.dim : {};
    const text: Style = {
        ...theme.text[marker],
        ...(line.focus ? { bold: true } : {}),
        ...context,
        ...over,
    };
    const piece = (s: Span): Style => ({
        ...(s.tone === 'marker' ? theme.glyph[marker] : theme.tone[s.tone]),
        ...context,
        ...over,
    });
    // Inverse without colour has no row background: pad each line to the edge.
    const pad = selected && !theme.color;
    // Each line is already wrapped to fit, so Ink never wraps again.
    return (
        <Box
            width={width}
            flexDirection="column"
            backgroundColor={selected ? theme.selectedRow.backgroundColor : undefined}
        >
            {row.lines.map((l, i) => (
                <Box key={l.start}>
                    <Box width={row.prefixWidth} flexShrink={0}>
                        <Text>
                            <Spans spans={i === 0 ? row.prefix : row.continuation} style={piece} />
                        </Text>
                    </Box>
                    <Text wrap="truncate-end" {...text}>
                        <Spans
                            spans={
                                pad
                                    ? [
                                          ...l.spans,
                                          {
                                              text: ' '.repeat(
                                                  Math.max(0, width - row.prefixWidth - l.width),
                                              ),
                                              tone: 'plain',
                                          },
                                      ]
                                    : l.spans
                            }
                            style={piece}
                        />
                    </Text>
                </Box>
            ))}
        </Box>
    );
}

/** Styled pieces of one line, keyed by where each starts. */
function Spans({ spans, style }: { spans: readonly Span[]; style: (s: Span) => Style }) {
    let at = 0;
    return spans
        .filter((s) => s.text !== '')
        .map((s) => {
            const key = at;
            at += s.text.length;
            return (
                <Text key={key} {...style(s)}>
                    {s.text}
                </Text>
            );
        });
}
