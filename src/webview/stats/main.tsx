import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * The Stats webview client — M1 stub. The combined activity calendar
 * (`react-activity-calendar`) + metric toggle + count tiles land in M2; this
 * just proves the entry builds, loads under the panel CSP, and mounts.
 */
function Stats() {
    return <main className="tsk-stats-stub">tsk — Stats (coming in M2)</main>;
}

const root = document.getElementById('root');
if (root) {
    createRoot(root).render(
        <StrictMode>
            <Stats />
        </StrictMode>,
    );
}
