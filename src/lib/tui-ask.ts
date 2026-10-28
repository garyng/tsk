/**
 * `m` in the `tsk` TUI sends the followed Claude session a message about a
 * task, by posting to its cross-session inbox socket. This is the
 * pure part: what the message says, and what a line of the session's
 * transcript says about it.
 *
 * A message has to say who and which task: a bare "pick up tsk:x" was not
 * acted on in a spike, a self-contained one was. It says "the user", since
 * the pane can't know a name.
 */

export interface MessageSubject {
    readonly id: string;
    /** The task's short title. */
    readonly title: string;
    /** The `.tsk` file the task is in, by name, as the session's `tsk` knows it. */
    readonly file: string;
}

const list = new Intl.ListFormat('en', { type: 'conjunction' });

/** The tasks, file by file: `tsk:a "step a" and tsk:b "step b" in claude.tsk`. */
function named(subjects: readonly MessageSubject[]): string {
    const files = [...new Set(subjects.map((s) => s.file))];
    return list.format(
        files.map((file) => {
            const here = subjects.filter((s) => s.file === file);
            return `${list.format(here.map((s) => `tsk:${s.id} "${s.title}"`))} in ${file}`;
        }),
    );
}

/** What the user typed at `m`, about the tasks marked (or the one selected); it can arrive mid-turn, hence the safe point. */
export function messageText(subjects: readonly MessageSubject[], said: string): string {
    return `From the tsk pane beside this session, about ${named(subjects)}, the user says: "${said.trim()}". If it asks for something other than what you're doing, bring that to a safe point first.`;
}

/** Where a posted message has got to: the session took it into its queue, read it, or dropped it unread. */
export type Delivery = 'queued' | 'read' | 'removed';

/** The fields of a transcript line this reads; the format is Claude Code's own and unversioned. */
interface TranscriptLine {
    readonly type?: string;
    readonly operation?: string;
    readonly content?: unknown;
    readonly reason?: string;
    readonly origin?: { readonly verifiedPeerPid?: number };
    readonly message?: { readonly content?: unknown };
    readonly attachment?: {
        readonly prompt?: unknown;
        readonly origin?: { readonly verifiedPeerPid?: number };
    };
}

/**
 * What one line of the session's transcript (`<sessionId>.jsonl`) says about
 * the message `text` that process `pid` posted, if anything. Claude Code
 * 2.1.296 writes a `queue-operation` `enqueue` carrying the text when the
 * session takes the line; then, idle, a `dequeue` and a `user` entry whose
 * `origin.verifiedPeerPid` is the poster's pid (the kernel's, not the
 * payload's), or mid-turn a `remove` with `reason: "absorbed_mid_turn"` and a
 * `queued_command` attachment with that origin. Any other `remove` dropped it.
 */
export function deliveryOf(
    line: string,
    mine: { text: string; pid: number },
): Delivery | undefined {
    let entry: TranscriptLine;
    try {
        entry = JSON.parse(line);
    } catch {
        return undefined; // a line cut off mid-write, or not JSON
    }
    if (entry === null || typeof entry !== 'object') return undefined;
    if (entry.type === 'queue-operation') {
        if (entry.content !== mine.text) return undefined;
        if (entry.operation === 'enqueue') return 'queued';
        if (entry.operation === 'remove')
            return entry.reason === 'absorbed_mid_turn' ? 'read' : 'removed';
        return undefined;
    }
    if (entry.origin?.verifiedPeerPid === mine.pid) {
        const content = entry.message?.content;
        if (typeof content === 'string' && content.includes(mine.text)) return 'read';
    }
    if (
        entry.attachment?.origin?.verifiedPeerPid === mine.pid &&
        entry.attachment.prompt === mine.text
    )
        return 'read';
    return undefined;
}

/** `m:ss` since a request went out, for the footer. */
export function elapsed(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
