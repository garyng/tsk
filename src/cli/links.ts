import { EXTENSION_ID, openTaskUri } from '../lib/task-uri';

/** A task's id where the output prints one: after its marker (`[x] `), before its text. */
const TASK_ID = /(\[[^\]]\] )([A-Za-z0-9_-]{1,64})(?= )/g;

/**
 * An OSC 8 hyperlink, written out: `ESC ] 8 ; ; <url> ST <text> ESC ] 8 ; ; ST`
 * (https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda). Not
 * `ansi-escapes`' `link`: inside tmux it wraps the link in tmux's passthrough,
 * which needs `allow-passthrough` and is lost on tmux's next redraw, while tmux
 * 3.4+ keeps a plain OSC 8 link as part of the text (`terminal-features
 * hyperlinks`); and it decides once, from `$TMUX`, at import.
 */
function hyperlink(text: string, url: string): string {
    return `\u001B]8;;${url}\u001B\\${text}\u001B]8;;\u001B\\`;
}

/**
 * `text` with each task's id an OSC 8 link to `vscode://garyng.tsk/open?id=<id>`:
 * Ctrl+Click opens the task in VS Code, from Windows
 * Terminal too, and through tmux. Only for a terminal; what Claude reads stays
 * plain. The id still reads as itself where a terminal shows no links.
 */
export function linkIds(text: string): string {
    return text.replace(
        TASK_ID,
        (_all, marker: string, id: string) =>
            `${marker}${hyperlink(id, openTaskUri('vscode', EXTENSION_ID, id))}`,
    );
}
