import stringWidth from 'string-width';
import { EXTENSION_ID, taskIdFromUri } from './task-uri';
import { taskRefsIn } from './tsk-ref';

/** What tmux tells a mouse binding about a click. */
export interface Click {
    /** The column in the pane, from 0 (`mouse_x`). */
    readonly column: number;
    /** The text of the line clicked (`mouse_line`). */
    readonly line: string;
    /** The OSC 8 link under the mouse, if any (`mouse_hyperlink`). */
    readonly hyperlink?: string;
}

/**
 * The task a click is on: the id a `…://garyng.tsk/open?id=<id>` link there
 * names (tsk's own output links its ids that way), else the `tsk:<id>` the
 * column falls in. Columns are the terminal's, so a wide character before the
 * ref counts two. Pure.
 */
export function clickedTaskId(click: Click): string | undefined {
    const linked = click.hyperlink ? taskIdFromLink(click.hyperlink) : undefined;
    if (linked) return linked;
    for (const ref of taskRefsIn(click.line)) {
        const start = stringWidth(click.line.slice(0, ref.start));
        const end = start + stringWidth(click.line.slice(ref.start, ref.end));
        if (click.column >= start && click.column < end) return ref.id;
    }
    return undefined;
}

/** The id a link to the extension's `/open` names, whatever the scheme (Insiders has its own). */
export function taskIdFromLink(link: string): string | undefined {
    let url: URL;
    try {
        url = new URL(link);
    } catch {
        return undefined;
    }
    return url.host === EXTENSION_ID ? taskIdFromUri(url.pathname, url.search.slice(1)) : undefined;
}
