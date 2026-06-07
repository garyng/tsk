import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * The Task-list webview client — M1 stub. The status-filtered list
 * (`@tanstack/react-table` + `-virtual`) lands in M3; this just proves the
 * entry builds, loads under the panel CSP, and mounts.
 */
function TaskList() {
    return <main className="tsk-task-list-stub">tsk — Task List (coming in M3)</main>;
}

const root = document.getElementById('root');
if (root) {
    createRoot(root).render(
        <StrictMode>
            <TaskList />
        </StrictMode>,
    );
}
