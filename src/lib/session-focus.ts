import type { Marker } from './markers';
import { isAncestorOrSelf, pathTo, type TaskTree, type TreeNode } from './task-tree';

/**
 * Which task an agent session is working on, worked out from the file alone —
 * no pointer is stored anywhere else.
 *
 * - `@session:<id>` marks the session that last took a task on (created or
 *   focused it). It moves when another session picks the task up.
 * - `@focused:<timestamp>` is stamped whenever a session puts a task in front
 *   of itself.
 * - A session's **focus** is its in-progress (`[/]`) task with the latest
 *   `@focused`. Finishing or parking the focus therefore falls back to the
 *   next-latest one — normally its parent — so a stack of sidetracks unwinds
 *   without anything else being recorded.
 * - `@agent:<name>` marks a task the session handed to one of its subagents or
 *   teammates. They run under the session's own id, so the task keeps the
 *   session's `@session`; it's never the focus, and the trail lists it apart.
 *
 * Pure — no I/O.
 */

export const SESSION_KEY = 'session';
export const FOCUSED_KEY = 'focused';
export const AGENT_KEY = 'agent';

/** Session ids are UUIDs; the first 8 characters are plenty to tell one person's sessions apart. */
const SESSION_ID_LENGTH = 8;

export function shortSessionId(id: string): string {
    return id.trim().slice(0, SESSION_ID_LENGTH);
}

/** Still to do: todo or in progress. */
export function isOpen(marker: Marker): boolean {
    return marker === 'todo' || marker === 'inprogress';
}

export function sessionOf(node: TreeNode): string | undefined {
    return node.task.metadata.get(SESSION_KEY) ?? undefined;
}

/** The session a task belongs to: its own `@session`, else its nearest ancestor's (a line written by hand). */
export function owningSession(node: TreeNode): string | undefined {
    for (let n: TreeNode | undefined = node; n; n = n.parent) {
        const session = sessionOf(n);
        if (session) return session;
    }
    return undefined;
}

/** The agent the task was handed to, if any. */
export function agentOf(node: TreeNode): string | undefined {
    return node.task.metadata.get(AGENT_KEY) ?? undefined;
}

/** Milliseconds of `@focused` (else `@started`); 0 when neither parses. */
function focusedAt(node: TreeNode): number {
    const stamp = node.task.metadata.get(FOCUSED_KEY) ?? node.task.metadata.get('started');
    const ms = stamp ? Date.parse(stamp) : Number.NaN;
    return Number.isNaN(ms) ? 0 : ms;
}

/**
 * True when `a` was focused more recently than `b`. `@focused` is stamped to
 * the millisecond, so a tie comes from stamps written before it was (one-second
 * precision, where a push often landed in the same second as the focus it
 * nests under) or from a `@started` fallback: a descendant then beats its
 * ancestor, since a push always lands under the focus; otherwise the later
 * line wins.
 */
function focusedAfter(a: TreeNode, b: TreeNode): boolean {
    const diff = focusedAt(a) - focusedAt(b);
    if (diff !== 0) return diff > 0;
    if (isAncestorOrSelf(b, a)) return true;
    if (isAncestorOrSelf(a, b)) return false;
    return a.task.line > b.task.line;
}

export function sessionFocus(tree: TaskTree, session: string): TreeNode | undefined {
    let best: TreeNode | undefined;
    for (const node of tree.nodes) {
        if (node.task.marker !== 'inprogress' || sessionOf(node) !== session) continue;
        if (agentOf(node) !== undefined) continue;
        if (best === undefined || focusedAfter(node, best)) best = node;
    }
    return best;
}

export interface Trail {
    readonly focus: TreeNode | undefined;
    /** Root → focus, inclusive; empty without a focus. */
    readonly path: readonly TreeNode[];
    /** The focus's children that are still open, but for those with agents. */
    readonly openChildren: readonly TreeNode[];
    /** The session's open tasks handed to agents, wherever they sit. */
    readonly withAgents: readonly TreeNode[];
    /** The session's other open tasks — parked sidetracks, work queued for later. */
    readonly otherOpen: readonly TreeNode[];
}

export function sessionTrail(tree: TaskTree, session: string): Trail {
    const focus = sessionFocus(tree, session);
    const path = focus ? pathTo(focus) : [];
    const onPath = new Set<TreeNode>(path);
    const withAgents = tree.nodes.filter(
        (n) =>
            !onPath.has(n) &&
            sessionOf(n) === session &&
            isOpen(n.task.marker) &&
            agentOf(n) !== undefined,
    );
    const handed = new Set<TreeNode>(withAgents);
    const openChildren = focus
        ? focus.children.filter((c) => isOpen(c.task.marker) && !handed.has(c))
        : [];
    const shown = new Set<TreeNode>([...path, ...openChildren, ...withAgents]);
    const otherOpen = tree.nodes.filter(
        (n) => !shown.has(n) && sessionOf(n) === session && isOpen(n.task.marker),
    );
    return { focus, path, openChildren, withAgents, otherOpen };
}
