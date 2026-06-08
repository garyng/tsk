import {
    defaultKeymap,
    InMemoryTreeSource,
    type Keymap,
    type Row,
    TreeController,
} from '@grida/tree-view';
import { TreeProvider, useTree, useTreeSnapshot } from '@grida/tree-view/react';
import codiconCss from '@vscode/codicons/dist/codicon.css?raw';
import codiconFont from '@vscode/codicons/dist/codicon.ttf?inline';
import {
    type KeyboardEvent,
    type MouseEvent,
    StrictMode,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { GLYPH } from '../../lib/markers';
import type { HostToWebview, WebviewToHost } from '../../lib/now-protocol';
import type { NowRowView } from '../../lib/now-row';
import { buildNowTreeSource, expandedNowIds } from '../../lib/now-tree-source';
import { injectStyle } from '../shared/inject-style';
import markerStyles from '../shared/marker.css?raw';
import styles from './now-stack.css?raw';

/**
 * The "now stack" webview client. Receives the resolved, linear-compaction rows
 * over the `render` bridge, reconstructs a grida tree (`buildNowTreeSource`),
 * and renders it via `@grida/tree-view` — which owns expand/collapse, keyboard
 * nav, and focus. Every user action posts a {@link WebviewToHost} message; the
 * panel routes it to the now-tree commands. Icons are VS Code codicons, bundled
 * in (font inlined) so the panel and the test harness both render natively.
 */

/** The VS Code webview API, injected into the webview global by the host. */
declare function acquireVsCodeApi(): {
    postMessage(message: WebviewToHost): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const post = (message: WebviewToHost): void => vscode.postMessage(message);

/** Persisted webview state (survives a reload / pop-out). */
interface PersistedState {
    collapsed?: string[];
}
const loadCollapsed = (): Set<string> =>
    new Set((vscode.getState() as PersistedState | undefined)?.collapsed ?? []);
const saveCollapsed = (collapsed: Set<string>): void =>
    vscode.setState({ collapsed: [...collapsed] } satisfies PersistedState);

/** px of indent per compacted depth level. */
const INDENT_STEP = 16;
const rowDomId = (id: string): string => `now-row-${id}`;

// `defaultKeymap` binds Enter/F2 to `rename` — but the now-tree has no inline
// rename. Remap them to `activate` so Enter jumps the focused row (↑/↓ move,
// →/← expand/collapse stay as grida's defaults).
const NOW_KEYMAP: Keymap = { ...defaultKeymap, Enter: 'activate', F2: 'activate' };

function NowStack() {
    const [rows, setRows] = useState<NowRowView[] | null>(null);

    useEffect(() => {
        const onMessage = (event: MessageEvent): void => {
            const data = event.data as Partial<HostToWebview> | undefined;
            if (data?.type === 'render') setRows(data.rows ?? []);
        };
        window.addEventListener('message', onMessage);
        // Tell the extension we're mounted so it posts the initial render.
        post({ type: 'ready' });
        return () => window.removeEventListener('message', onMessage);
    }, []);

    const empty = !rows || rows.length === 0;
    return (
        <main className="now-stack">
            {empty ? (
                // `null` (pre-handshake) and `[]` (empty tree) both render empty.
                <p className="now-stack__empty">
                    No task marked as "now" — run <strong>Tsk: Mark Now</strong> on a task.
                </p>
            ) : (
                <NowTree rows={rows} />
            )}
        </main>
    );
}

function NowTree({ rows }: { rows: NowRowView[] }) {
    // The forks the user has collapsed — survives a re-render (every store change
    // rebuilds the controller) and, via setState, a panel reload / pop-out.
    const collapsedRef = useRef<Set<string>>(loadCollapsed());
    // Set while a programmatic reveal() expands ancestors, so that expansion
    // isn't persisted as the user un-collapsing those forks (A4).
    const suppressPersist = useRef(false);

    const controller = useMemo(() => {
        const { root, nodes } = buildNowTreeSource(rows);
        const source = new InMemoryTreeSource<NowRowView>({ root, nodes, showRoot: false });
        // Start every fork expanded EXCEPT the ones the user collapsed.
        const expanded = expandedNowIds(rows).filter((id) => !collapsedRef.current.has(id));
        return new TreeController<NowRowView>({ source, expanded });
    }, [rows]);
    useEffect(() => () => controller.dispose(), [controller]);

    // Remember collapses as the user toggles (only current forks, so the set
    // can't accumulate stale ids).
    useEffect(() => {
        return controller.subscribe('expanded', () => {
            if (suppressPersist.current) return; // a reveal-driven expand, not a user toggle
            const expanded = controller.getExpanded();
            const collapsed = new Set(expandedNowIds(rows).filter((id) => !expanded.has(id)));
            collapsedRef.current = collapsed;
            saveCollapsed(collapsed);
        });
    }, [controller, rows]);

    // Keyboard `Enter` → grida emits an `activate` intent → jump that row.
    useEffect(() => {
        return controller.subscribe('intent', (intent) => {
            if (intent.kind !== 'activate') return;
            const meta = controller.source.getNode(intent.id).meta;
            if (meta) post({ type: 'jump', id: meta.id });
        });
    }, [controller]);

    const currentEntryId = rows.find((r) => r.current)?.entryId;
    const revealCurrent = (): void => {
        if (!currentEntryId) return;
        // Suppress the collapse-persist for the ancestor forks reveal() expands
        // (A4); scroll only after React commits the now-shown row — double rAF,
        // since grida's expand re-renders on the next frame (B2).
        suppressPersist.current = true;
        controller.reveal(currentEntryId);
        suppressPersist.current = false;
        requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                document
                    .getElementById(rowDomId(currentEntryId))
                    ?.scrollIntoView({ block: 'center' });
            }),
        );
    };
    return (
        <TreeProvider controller={controller}>
            <Toolbar onRevealCurrent={revealCurrent} />
            <NowRows />
        </TreeProvider>
    );
}

function Toolbar({ onRevealCurrent }: { onRevealCurrent: () => void }) {
    return (
        <div className="now-toolbar">
            <IconButton
                icon="discard"
                title="Back (switch to parent)"
                onClick={() => post({ type: 'back' })}
            />
            <IconButton
                icon="list-flat"
                title="Prune off-path branches"
                onClick={() => post({ type: 'pruneOffPath' })}
            />
            <IconButton icon="location" title="Reveal current now" onClick={onRevealCurrent} />
            <IconButton
                icon="clear-all"
                title="Clear now history"
                onClick={() => post({ type: 'clear' })}
            />
        </div>
    );
}

function NowRows() {
    const ctrl = useTree<NowRowView>();
    const rows = useTreeSnapshot((c) => c.getRows());
    const focused = useTreeSnapshot((c) => c.getFocused());
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        const { handled } = ctrl.keyDown(event, NOW_KEYMAP);
        if (handled) event.preventDefault();
    };
    // Only reference a focused row that's actually rendered: grida can retain a
    // focus id whose row is now collapsed/pruned away, which would make
    // aria-activedescendant point at a non-existent element (B3).
    const activeId = focused && rows.some((r) => r.id === focused) ? focused : undefined;
    return (
        <div
            className="now-tree"
            role="tree"
            tabIndex={0}
            aria-activedescendant={activeId ? rowDomId(activeId) : undefined}
            onKeyDown={onKeyDown}
        >
            {rows.map((row) => (
                <NowRowItem key={row.id} row={row} focused={row.id === focused} />
            ))}
        </div>
    );
}

function NowRowItem({ row, focused }: { row: Row; focused: boolean }) {
    const ctrl = useTree<NowRowView>();
    const meta = ctrl.source.getNode(row.id).meta;
    if (!meta) return null;

    const toggle = (event: MouseEvent): void => {
        event.stopPropagation();
        ctrl.toggle(row.id);
    };
    const jump = (): void => {
        ctrl.focus(row.id);
        post({ type: 'jump', id: meta.id });
    };

    return (
        // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is handled by the tree container's keymap (Enter → activate → jump).
        <div
            role="treeitem"
            id={rowDomId(row.id)}
            tabIndex={-1}
            aria-expanded={row.isContainer ? row.isExpanded : undefined}
            data-state={meta.current ? 'current' : 'idle'}
            data-focused={focused || undefined}
            data-tree-row-id={row.id}
            className="now-row"
            style={{ paddingLeft: 4 + row.depth * INDENT_STEP }}
            onClick={jump}
        >
            {row.isContainer ? (
                <button
                    type="button"
                    className="now-row__twistie"
                    aria-label={row.isExpanded ? 'Collapse' : 'Expand'}
                    onClick={toggle}
                >
                    <Codicon name={row.isExpanded ? 'chevron-down' : 'chevron-right'} />
                </button>
            ) : (
                <span className="now-row__twistie" aria-hidden="true" />
            )}
            <span className="now-row__icon" aria-hidden="true">
                {meta.current ? <Codicon name="circle-filled" /> : null}
            </span>
            {meta.marker ? (
                <span
                    className="tsk-marker now-row__marker"
                    data-marker={meta.marker}
                    aria-hidden="true"
                >
                    [{GLYPH[meta.marker]}]
                </span>
            ) : null}
            <span
                className={`now-row__label${meta.resolved ? '' : ' now-row__label--missing'}`}
                title={meta.label}
            >
                {meta.label}
            </span>
            <span className="now-row__when">{meta.when}</span>
            <span className="now-row__actions">
                <RowAction
                    icon="target"
                    title="Set as current now"
                    action="switchTo"
                    entryId={row.id}
                />
                <RowAction
                    icon="remove"
                    title="Remove children"
                    action="pruneChildren"
                    entryId={row.id}
                />
                <RowAction
                    icon="close"
                    title="Remove this entry"
                    action="remove"
                    entryId={row.id}
                />
                <RowAction
                    icon="trash"
                    title="Delete this branch"
                    action="pruneSubtree"
                    entryId={row.id}
                />
            </span>
        </div>
    );
}

type RowActionType = 'switchTo' | 'remove' | 'pruneSubtree' | 'pruneChildren';

function RowAction({
    icon,
    title,
    action,
    entryId,
}: {
    icon: string;
    title: string;
    action: RowActionType;
    entryId: string;
}) {
    const onClick = (event: MouseEvent): void => {
        event.stopPropagation(); // don't also trigger the row's jump
        post({ type: action, entryId });
    };
    return <IconButton icon={icon} title={title} onClick={onClick} className="now-row__action" />;
}

function IconButton({
    icon,
    title,
    onClick,
    className,
}: {
    icon: string;
    title: string;
    onClick: (event: MouseEvent) => void;
    className?: string;
}) {
    return (
        <button
            type="button"
            className={`now-icon-btn${className ? ` ${className}` : ''}`}
            title={title}
            aria-label={title}
            onClick={onClick}
        >
            <Codicon name={icon} />
        </button>
    );
}

function Codicon({ name }: { name: string }) {
    return <span className={`codicon codicon-${name}`} aria-hidden="true" />;
}

/**
 * Inject the codicon font + the now-stack stylesheet (`now-stack.css`) once at
 * load. The codicon CSS ships a relative `url(./codicon.ttf)`; rewrite it to the
 * inlined data-URI font so nothing external loads. Kept in-bundle so the host
 * panel and the standalone Playwright harness both get the skin + icons for free.
 */
function injectStyles(): void {
    const codicons = codiconCss.replace(/url\([^)]*codicon\.ttf[^)]*\)/, `url(${codiconFont})`);
    injectStyle('tsk-marker-style', markerStyles);
    injectStyle('now-stack-style', `${codicons}\n${styles}`);
}

injectStyles();

const container = document.getElementById('root');
if (container) {
    createRoot(container).render(
        <StrictMode>
            <NowStack />
        </StrictMode>,
    );
}
