import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * The "now stack" webview client (M46 shell). For now it just mounts, signals
 * readiness to the extension, and renders an empty state; the actual tree (the
 * `@grida/tree-view` controller + the linear-compaction rows) lands in M47, fed
 * by the `render` messages this already listens for.
 */

/**
 * The VS Code webview API, injected into the webview global by the host.
 * Declared minimally — we post action messages and (M46/B) persist view state
 * across reloads via get/setState.
 */
declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

/** Messages the extension posts INTO the webview. (Rows arrive in M47.) */
interface RenderMessage {
    type: 'render';
}

function isRenderMessage(value: unknown): value is RenderMessage {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { type?: unknown }).type === 'render'
    );
}

function NowStack() {
    const [rendered, setRendered] = useState(false);

    useEffect(() => {
        const onMessage = (event: MessageEvent): void => {
            if (isRenderMessage(event.data)) setRendered(true);
        };
        window.addEventListener('message', onMessage);
        // Tell the extension we're mounted so it posts the initial render.
        vscode.postMessage({ type: 'ready' });
        return () => window.removeEventListener('message', onMessage);
    }, []);

    return (
        <main className="now-stack">
            {rendered ? (
                <p className="now-stack__placeholder">Now-stack tree renders here (M47).</p>
            ) : (
                <p className="now-stack__empty">No task marked as "now" — press Alt+W on a task.</p>
            )}
        </main>
    );
}

const container = document.getElementById('root');
if (container) {
    createRoot(container).render(
        <StrictMode>
            <NowStack />
        </StrictMode>,
    );
}
