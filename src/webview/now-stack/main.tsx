import { InMemoryTreeSource, type Row, TreeController } from '@grida/tree-view';
import { TreeProvider, useTree, useTreeSnapshot } from '@grida/tree-view/react';
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HostToWebview, WebviewToHost } from '../../lib/now-protocol';
import type { NowRowView } from '../../lib/now-row';
import { buildNowTreeSource, expandedNowIds } from '../../lib/now-tree-source';

/**
 * The "now stack" webview client. Receives the resolved, linear-compaction rows
 * over the `render` bridge, reconstructs a grida tree from them
 * (`buildNowTreeSource`), and renders it via `@grida/tree-view` — which owns
 * expand/collapse, keyboard, focus, and selection. Row actions + keyboard land
 * in M47/C3; this is the first on-screen render (indent, twistie, label, when,
 * current highlight).
 */

/** The VS Code webview API, injected into the webview global by the host. */
declare function acquireVsCodeApi(): {
    postMessage(message: WebviewToHost): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

/** px of indent per compacted depth level. */
const INDENT_STEP = 16;

function NowStack() {
    const [rows, setRows] = useState<NowRowView[] | null>(null);

    useEffect(() => {
        const onMessage = (event: MessageEvent): void => {
            const data = event.data as Partial<HostToWebview> | undefined;
            if (data?.type === 'render') setRows(data.rows ?? []);
        };
        window.addEventListener('message', onMessage);
        // Tell the extension we're mounted so it posts the initial render.
        vscode.postMessage({ type: 'ready' });
        return () => window.removeEventListener('message', onMessage);
    }, []);

    // `null` (pre-handshake) and `[]` (empty tree) both render the empty state.
    if (!rows || rows.length === 0) {
        return (
            <main className="now-stack">
                <p className="now-stack__empty">No task marked as "now" — press Alt+W on a task.</p>
            </main>
        );
    }
    return (
        <main className="now-stack">
            <NowTree rows={rows} />
        </main>
    );
}

function NowTree({ rows }: { rows: NowRowView[] }) {
    // Rebuild the grida tree whenever the rows change. All forks start expanded
    // (the fully-compacted view); cross-render collapse persistence is M47/C3.
    const controller = useMemo(() => {
        const { root, nodes } = buildNowTreeSource(rows);
        const source = new InMemoryTreeSource<NowRowView>({ root, nodes, showRoot: false });
        return new TreeController<NowRowView>({ source, expanded: expandedNowIds(rows) });
    }, [rows]);
    useEffect(() => () => controller.dispose(), [controller]);

    return (
        <TreeProvider controller={controller}>
            <NowRows />
        </TreeProvider>
    );
}

function NowRows() {
    const rows = useTreeSnapshot((c) => c.getRows());
    return (
        <div className="now-tree" role="tree">
            {rows.map((row) => (
                <NowRowItem key={row.id} row={row} />
            ))}
        </div>
    );
}

function NowRowItem({ row }: { row: Row }) {
    const ctrl = useTree<NowRowView>();
    const meta = ctrl.source.getNode(row.id).meta;
    if (!meta) return null;

    return (
        <div
            role="treeitem"
            aria-expanded={row.isContainer ? row.isExpanded : undefined}
            tabIndex={-1}
            data-state={meta.current ? 'current' : 'idle'}
            data-tree-row-id={row.id}
            className="now-row"
            style={{ paddingLeft: 4 + row.depth * INDENT_STEP }}
        >
            {row.isContainer ? (
                <button
                    type="button"
                    className="now-row__twistie"
                    aria-label={row.isExpanded ? 'Collapse' : 'Expand'}
                    onClick={() => ctrl.toggle(row.id)}
                >
                    {row.isExpanded ? '▾' : '▸'}
                </button>
            ) : (
                <span className="now-row__twistie" aria-hidden="true" />
            )}
            <span className="now-row__icon" aria-hidden="true">
                {meta.current ? '◉' : ''}
            </span>
            <span
                className={`now-row__label${meta.resolved ? '' : ' now-row__label--missing'}`}
                title={meta.label}
            >
                {meta.label}
            </span>
            <span className="now-row__when">{meta.when}</span>
        </div>
    );
}

/**
 * Theme-aware styles, injected once at load. Kept in-bundle (not a separate
 * `.css`) so the single shipped JS carries its own skin — the host and the
 * Playwright harness both get it for free. Every color is a `var(--vscode-*)`
 * with a dark fallback so the standalone golden still renders meaningfully.
 */
const STYLE = `
.now-stack { padding: 4px 0; color: var(--vscode-foreground, #cccccc);
    font: var(--vscode-font-size, 13px) / 1.4 var(--vscode-font-family, system-ui, "Segoe UI", sans-serif); }
.now-stack__empty { padding: 8px 12px; color: var(--vscode-descriptionForeground, #8c8c8c); }
.now-tree { list-style: none; margin: 0; padding: 0; }
.now-row { display: flex; align-items: center; height: 22px; padding-right: 10px;
    user-select: none; white-space: nowrap; outline: none; }
.now-row:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.07)); }
.now-row[data-state="current"] { background: var(--vscode-list-inactiveSelectionBackground, rgba(255,255,255,0.10));
    box-shadow: inset 2px 0 0 var(--vscode-focusBorder, #007fd4); }
.now-row__twistie { flex: 0 0 16px; width: 16px; height: 22px; padding: 0; margin: 0;
    display: inline-flex; align-items: center; justify-content: center; font-size: 10px;
    background: none; border: none; cursor: pointer; color: var(--vscode-icon-foreground, #c5c5c5); }
.now-row__icon { flex: 0 0 14px; text-align: center; color: var(--vscode-charts-blue, #3794ff); }
.now-row__label { overflow: hidden; text-overflow: ellipsis; }
.now-row__label--missing { font-style: italic; color: var(--vscode-descriptionForeground, #8c8c8c); }
.now-row__when { margin-left: auto; padding-left: 12px; font-size: 0.9em;
    color: var(--vscode-descriptionForeground, #8c8c8c); }
`;

function injectStyle(): void {
    const id = 'now-stack-style';
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id;
    el.textContent = STYLE;
    document.head.appendChild(el);
}

injectStyle();

const container = document.getElementById('root');
if (container) {
    createRoot(container).render(
        <StrictMode>
            <NowStack />
        </StrictMode>,
    );
}
