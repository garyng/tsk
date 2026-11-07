import stringWidth from 'string-width';
import type { Marker } from './parser';
import { buildTaskTree, type TreeNode } from './task-tree';

/**
 * What changed in a `.tsk` file between two versions, task by task (matched
 * by `@id`) and grouped by the session that owns each task: the message
 * `tsk commit` writes. Pure — no I/O.
 */

export type ChangeKind =
    | 'added'
    | 'removed'
    | 'done'
    | 'cancelled'
    | 'moved'
    | 'started'
    | 'parked'
    | 'reopened'
    | 'reworded'
    | 'reparented'
    | 'changed';

export interface TaskChange {
    readonly id: string;
    /** The task's text without its `[[links]]`. */
    readonly title: string;
    /** In the order a message names them; never empty. */
    readonly kinds: readonly ChangeKind[];
}

export interface SessionChanges {
    /** The owning task's `@session`; undefined for tasks that carry none. */
    readonly session: string | undefined;
    /** In document order: the newer version's, then the removed tasks'. */
    readonly tasks: readonly TaskChange[];
}

export interface FileChanges {
    /** Each session the first time one of its tasks changed; tasks without a session last. */
    readonly sessions: readonly SessionChanges[];
    /** Some line that is no task with an `@id` changed too: prose, a heading, a task without an id. */
    readonly otherLines: boolean;
    /** Tasks in both versions stand in another order. */
    readonly reordered: boolean;
}

/** The stamps every `tsk focus` rewrites: committed, but not worth a line. */
const STAMPS = /\s@(?:focused|started)(?::[^\s>]*)?/g;

const MARKER_KIND: Partial<Record<Marker, ChangeKind>> = {
    completed: 'done',
    cancelled: 'cancelled',
    moved: 'moved',
    inprogress: 'started',
};

function kindsOf(was: TreeNode, now: TreeNode): ChangeKind[] {
    const kinds: ChangeKind[] = [];
    const [a, b] = [was.task, now.task];
    if (a.marker !== b.marker) {
        if (b.marker === 'todo') kinds.push(a.marker === 'inprogress' ? 'parked' : 'reopened');
        else kinds.push(MARKER_KIND[b.marker] ?? 'changed');
    }
    if (a.content !== b.content) kinds.push('reworded');
    if (was.parent?.id !== now.parent?.id) kinds.push('reparented');
    if (kinds.length === 0 && a.raw.replace(STAMPS, '') !== b.raw.replace(STAMPS, '')) {
        kinds.push('changed');
    }
    return kinds;
}

const titleOf = (node: TreeNode) =>
    node.task.content
        .replace(/\s*\[\[[^\]]*\]\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

/** The lines that aren't a task with an `@id`, as a count of each. */
function otherLineCounts(lines: readonly string[], ids: ReadonlySet<number>) {
    const counts = new Map<string, number>();
    lines.forEach((l, i) => {
        if (!ids.has(i) && l.trim() !== '') counts.set(l, (counts.get(l) ?? 0) + 1);
    });
    return counts;
}

export function fileChanges(before: readonly string[], after: readonly string[]): FileChanges {
    const [was, now] = [buildTaskTree(before), buildTaskTree(after)];
    const bySession = new Map<string | undefined, TaskChange[]>();
    const add = (node: TreeNode, kinds: ChangeKind[]) => {
        if (kinds.length === 0 || node.id === undefined) return;
        const session = node.task.metadata.get('session') ?? undefined;
        const list = bySession.get(session) ?? [];
        list.push({ id: node.id, title: titleOf(node), kinds });
        bySession.set(session, list);
    };
    for (const [id, node] of now.byId) {
        const old = was.byId.get(id);
        add(node, old ? kindsOf(old, node) : ['added']);
    }
    for (const [id, node] of was.byId) if (!now.byId.has(id)) add(node, ['removed']);

    const idLines = (t: typeof was) => new Set([...t.byId.values()].map((n) => n.task.line));
    const [a, b] = [otherLineCounts(before, idLines(was)), otherLineCounts(after, idLines(now))];
    const otherLines = a.size !== b.size || [...a].some(([l, n]) => b.get(l) !== n);
    const kept = (t: typeof was, other: typeof was) =>
        [...t.byId.keys()].filter((id) => other.byId.has(id)).join(' ');
    const reordered = kept(was, now) !== kept(now, was);

    const sessions = [...bySession]
        .map(([session, tasks]) => ({ session, tasks }))
        .sort((x, y) => Number(x.session === undefined) - Number(y.session === undefined));
    return { sessions, otherLines, reordered };
}

/** A message line's width; a task's title is cut to fit. */
const LINE_WIDTH = 72;
/** Sessions the title names before it counts the rest. */
const TITLE_SESSIONS = 3;

function cut(text: string, width: number): string {
    if (stringWidth(text) <= width) return text;
    let out = '';
    for (const ch of text) {
        if (stringWidth(`${out}${ch}…`) > width) break;
        out += ch;
    }
    return `${out}…`;
}

/** `tsk commit`'s message for the file `name`: a title naming the sessions, a line per task. */
export function commitMessage(name: string, changes: FileChanges): string {
    const named = changes.sessions.flatMap((s) => (s.session ? [s.session] : []));
    const byHand = changes.sessions.some((s) => !s.session);
    let from: string;
    if (named.length > TITLE_SESSIONS) from = ` from ${named.length} sessions`;
    else if (named.length > 0) from = ` from ${named.join(', ')}`;
    else if (byHand || changes.otherLines) from = ', edited by hand';
    else if (changes.reordered) from = ', reordered';
    else from = ', focus stamps';
    const body = changes.sessions.flatMap((s) => [
        `${s.session ?? 'without a session'}:`,
        ...s.tasks.map((t) => {
            const head = `  ${t.kinds.join(', ')} tsk:${t.id}`;
            return t.title ? `${head} ${cut(t.title, LINE_WIDTH - stringWidth(head) - 1)}` : head;
        }),
    ]);
    if (changes.otherLines) body.push('Lines without an @id changed too.');
    // A task put under another moves in the order too; its line already says so.
    const reparented = changes.sessions.some((s) =>
        s.tasks.some((t) => t.kinds.includes('reparented')),
    );
    if (changes.reordered && !reparented) body.push('Tasks moved within the file.');
    if (body.length === 0) body.push('Only focus stamps changed.');
    return `chore: ${name}${from}\n\n${body.join('\n')}\n`;
}
