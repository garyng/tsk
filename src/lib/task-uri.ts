/**
 * The ids `tsk.revealTask` and the `vscode://garyng.tsk/open?id=<id>` URI
 * handler take, pure. An id is one word of letters, digits, `_` or `-` —
 * what a plan's `tsk:<id>` names, the generator's ids and hand-written ones
 * alike.
 */

/** The URI path that opens a task. */
export const OPEN_TASK_PATH = '/open';
/** The extension as VS Code names it, `<publisher>.<name>`, for a URI read outside it (tmux's Ctrl+Click). */
export const EXTENSION_ID = 'garyng.tsk';

const ID_RE = /^[A-Za-z0-9_-]+$/;
const PREFIX_RE = /^(?:tsk:|@id:)/;

/** What was typed or pasted as a task id: trimmed, `tsk:` / `@id:` dropped. */
export function taskIdFromInput(text: string): string | undefined {
    const id = text.trim().replace(PREFIX_RE, '');
    return ID_RE.test(id) ? id : undefined;
}

/** The URI that opens task `id`: `scheme` is `vscode.env.uriScheme`, so Insiders gets its own. */
export function openTaskUri(scheme: string, extensionId: string, id: string): string {
    return `${scheme}://${extensionId}${OPEN_TASK_PATH}?id=${encodeURIComponent(id)}`;
}

/** The id a `…/open?id=<id>` URI names, from the URI's path and query. */
export function taskIdFromUri(path: string, query: string): string | undefined {
    if (path !== OPEN_TASK_PATH) return undefined;
    const id = new URLSearchParams(query).get('id');
    return id === null ? undefined : taskIdFromInput(id);
}
