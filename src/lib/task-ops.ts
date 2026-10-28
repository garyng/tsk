import { cycleIfDepends } from './dependencies';
import { generateId } from './ids';
import { GLYPH } from './markers';
import { parseLine } from './parser';
import { LIST_KEY } from './relationships';
import { AGENT_KEY, FOCUSED_KEY, isOpen, SESSION_KEY, sessionOf } from './session-focus';
import {
    buildTaskTree,
    indentLevel,
    lookupId,
    MAX_NEST_LEVELS,
    type OutsideFile,
    subtreeEnd,
    type TaskTree,
    type TreeNode,
    withOutside,
} from './task-tree';
import { localTimestamp, localTimestampMs } from './time';
import {
    addListEntry,
    removeListEntry,
    removeMetadataEntry,
    setMetadataEntry,
    swapMarker,
    taskContentRange,
    wrapAsTask,
} from './toggle';
import {
    enterInprogress,
    enterState,
    type StateMarker,
    toggleCancelledMutator,
    toggleCompletedMutator,
} from './toggle-mutators';
import { wikiLinkSpans } from './wiki-link';

/**
 * The edits the `tsk` command line makes, as pure functions over a document's
 * lines: each finds its task **by `@id`** (never by line number, since another
 * writer may have moved it), changes that one line — or inserts one — and
 * returns the new lines. The store around them re-reads the file under a lock
 * before every call, so these never see stale text.
 *
 * Every transition reuses the extension's own mutators, so a task the command
 * line finishes carries exactly the stamps `Alt+C` would have written.
 */

export interface OpsDeps {
    generateId: () => string;
    now: () => string;
    /** The same clock to the millisecond, for `@focused`, which orders the session's focuses. */
    nowMs: () => string;
}

export const defaultOpsDeps: OpsDeps = { generateId, now: localTimestamp, nowMs: localTimestampMs };

export class TaskOpError extends Error {}

export interface OpResult {
    readonly lines: string[];
    /** The task the operation acted on (the new one, for an insert). */
    readonly id: string;
    /** False when the task was already in the requested state. */
    readonly changed: boolean;
}

export interface AddOptions {
    readonly text: string;
    /** Insert as the last child of this task; a new root at the end of the file when absent. */
    readonly parentId?: string;
    /** Start it (`[/]` + `@started`) and focus it — a sidetrack. */
    readonly start?: boolean;
    /** Start it for this agent instead (`@agent`), leaving the session's focus alone. */
    readonly agent?: string;
    /** Stamped as `@session`. */
    readonly session?: string;
}

export function findNode(tree: TaskTree, id: string): TreeNode {
    const node = tree.byId.get(id);
    if (!node) throw new TaskOpError(`no task with @id:${id}`);
    return node;
}

/** The name an Agent tool call gives a subagent or teammate: one word, as a metadata value must be. */
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkAgentName(name: string): string {
    if (!AGENT_NAME_RE.test(name)) {
        throw new TaskOpError(
            `"${name}" isn't an agent name — one word of letters, digits, '.', '_' or '-'`,
        );
    }
    return name;
}

function freshId(tree: TaskTree, deps: OpsDeps): string {
    for (;;) {
        const id = deps.generateId();
        if (!tree.byId.has(id)) return id;
    }
}

/** Where a new last child of `parent` goes, and how it's indented. */
function placement(tree: TaskTree, parent: TreeNode | undefined) {
    if (!parent) {
        let at = tree.lines.length;
        while (at > 0 && (tree.lines[at - 1] as string).trim() === '') at--;
        return { at, indent: '', parentRef: undefined };
    }
    const at = subtreeEnd(tree, parent) + 1;
    if (indentLevel(parent) + 1 < MAX_NEST_LEVELS) {
        const unit = parent.task.indent.includes('\t') ? '\t' : '  ';
        return { at, indent: parent.task.indent + unit, parentRef: undefined };
    }
    // Past the cap: a sibling of its parent, held on by `@parent`.
    return { at, indent: parent.task.indent, parentRef: parent.id };
}

export function addTask(lines: readonly string[], opts: AddOptions, deps: OpsDeps): OpResult {
    const text = opts.text.replace(/\s+/g, ' ').trim();
    if (text === '') throw new TaskOpError('a task needs some text');
    const agent = opts.agent === undefined ? undefined : checkAgentName(opts.agent);
    const tree = buildTaskTree(lines);
    const parent = opts.parentId === undefined ? undefined : findNode(tree, opts.parentId);
    if (parent && parent.id === undefined) throw new TaskOpError('the parent task has no @id');
    const { at, indent, parentRef } = placement(tree, parent);

    const id = freshId(tree, deps);
    let line = wrapAsTask(`${indent}${text}`, 'todo', { id, timestamp: deps.now() });
    if (parseLine(line)?.metadata.get('id') !== id) {
        throw new TaskOpError(`"${text}" already reads as a task line; give the text only`);
    }
    if (opts.start || agent) line = enterInprogress(line, deps);
    if (opts.session) line = setMetadataEntry(line, SESSION_KEY, opts.session);
    if (agent) line = setMetadataEntry(line, AGENT_KEY, agent);
    else if (opts.start) line = setMetadataEntry(line, FOCUSED_KEY, deps.nowMs());
    if (parentRef) line = setMetadataEntry(line, 'parent', parentRef);

    const next = [...lines];
    next.splice(at, 0, line);
    return { lines: next, id, changed: true };
}

/** Apply `edit` to the task's line; `changed` reports whether the text moved. */
function editLine(
    lines: readonly string[],
    id: string,
    edit: (line: string, node: TreeNode) => string,
): OpResult {
    const node = findNode(buildTaskTree(lines), id);
    const before = lines[node.task.line] as string;
    const after = edit(before, node);
    const next = [...lines];
    next[node.task.line] = after;
    return { lines: next, id, changed: after !== before };
}

/**
 * Put a task in front of `session`: start it if needed, and re-stamp who and
 * when. A task handed to an agent comes back, losing its `@agent`.
 */
export function focusTask(
    lines: readonly string[],
    id: string,
    session: string | undefined,
    deps: OpsDeps,
): OpResult {
    return editLine(lines, id, (line) => {
        let out = removeMetadataEntry(enterInprogress(line, deps), AGENT_KEY);
        if (session) out = setMetadataEntry(out, SESSION_KEY, session);
        return setMetadataEntry(out, FOCUSED_KEY, deps.nowMs());
    });
}

/**
 * Hand a task to one of the session's agents: start it if needed, stamped
 * with the session and `@agent:<name>` but not `@focused`, so the session's
 * focus stays where it was (or, for the focus itself, falls back to the next).
 */
export function delegateTask(
    lines: readonly string[],
    id: string,
    agent: string,
    session: string,
    deps: OpsDeps,
): OpResult {
    const name = checkAgentName(agent);
    return editLine(lines, id, (line) => {
        const out = setMetadataEntry(enterInprogress(line, deps), SESSION_KEY, session);
        return setMetadataEntry(out, AGENT_KEY, name);
    });
}

/** `done` / `cancel`: set-only, so finishing a finished task keeps its original stamp. */
export function finishTask(
    lines: readonly string[],
    id: string,
    state: Exclude<StateMarker, 'inprogress'>,
    deps: OpsDeps,
): OpResult {
    return editLine(lines, id, (line) => enterState(line, state, deps));
}

/** The `Alt+C` / `Alt+X` toggles: into the state, or back to `[ ]` when already there. */
export function toggleFinished(
    lines: readonly string[],
    id: string,
    state: Exclude<StateMarker, 'inprogress'>,
    deps: OpsDeps,
): OpResult {
    const mutator = state === 'completed' ? toggleCompletedMutator : toggleCancelledMutator;
    return editLine(lines, id, (line) => mutator(line, deps));
}

/** Back to `[ ]` for later — the in-progress toggle's way back, dropping `@focused` and `@agent` too. */
export function parkTask(lines: readonly string[], id: string): OpResult {
    return editLine(lines, id, (line, node) => {
        if (node.task.marker === 'todo') return line;
        if (node.task.marker !== 'inprogress') {
            throw new TaskOpError(
                `@id:${id} is [${GLYPH[node.task.marker]}], not in progress — only an in-progress task can be parked`,
            );
        }
        const todo = removeMetadataEntry(swapMarker(line, 'todo'), 'started');
        return removeMetadataEntry(removeMetadataEntry(todo, FOCUSED_KEY), AGENT_KEY);
    });
}

/**
 * `id` can't start until each of `onIds` is done: they're appended to its
 * `@dependsOn` list in order, skipping any already there. Refuses a task
 * depending on itself, an id that isn't in the file, and a dependency that
 * would close a loop — naming the loop, which (blocking being inherited
 * through nesting) includes depending on one's own sub-task.
 */
export function addDependencies(
    lines: readonly string[],
    id: string,
    onIds: readonly string[],
    outside: readonly OutsideFile[] = [],
): OpResult {
    // The task is this file's, to edit its line; what it waits on can be in a file beside it.
    const tree = withOutside(buildTaskTree(lines), outside);
    const node = findNode(tree, id);
    for (const onId of onIds) {
        if (onId === id) throw new TaskOpError('a task cannot depend on itself');
        const on = lookupId(tree, onId);
        if (!on) throw new TaskOpError(`no task with @id:${onId} in this file or beside it`);
        const loop = cycleIfDepends(tree, node, on);
        if (loop) {
            const last = loop[loop.length - 1];
            const inside = last && last !== node ? `, which is inside ${id}` : '';
            const chain = [node, ...loop].map((n) => n.id ?? `line ${n.task.line + 1}`);
            throw new TaskOpError(
                `${id} can't depend on ${onId}: that closes a loop, ${chain.join(' → ')}${inside}`,
            );
        }
    }
    return editLine(lines, id, (line) =>
        onIds.reduce((l, onId) => addListEntry(l, LIST_KEY, onId), line),
    );
}

/** Drop `offIds` from `id`'s `@dependsOn`; the key goes with the last one. */
export function removeDependencies(
    lines: readonly string[],
    id: string,
    offIds: readonly string[],
): OpResult {
    return editLine(lines, id, (line) =>
        offIds.reduce((l, offId) => removeListEntry(l, LIST_KEY, offId), line),
    );
}

/**
 * Re-stamp every **open** task of session `from` to session `to` — what a
 * conversation that changed its session id in place (`/clear`, `/branch`)
 * does with the unfinished work it was carrying. Finished tasks keep the
 * session that did them.
 */
export function handOverSession(
    lines: readonly string[],
    from: string,
    to: string,
): { lines: string[]; count: number } {
    const tree = buildTaskTree(lines);
    const next = [...lines];
    let count = 0;
    for (const node of tree.nodes) {
        if (sessionOf(node) !== from || !isOpen(node.task.marker)) continue;
        next[node.task.line] = setMetadataEntry(next[node.task.line] as string, SESSION_KEY, to);
        count++;
    }
    return { lines: next, count };
}

/** Append a `[[path]]` link to the task's text, unless it already links there. */
export function linkTask(lines: readonly string[], id: string, path: string): OpResult {
    const target = path.trim();
    if (target === '' || /[[\]\n]/.test(target))
        throw new TaskOpError(`not a linkable path: "${path}"`);
    return editLine(lines, id, (line) => {
        if (wikiLinkSpans(line).some((s) => s.path === target)) return line;
        const range = taskContentRange(line);
        if (!range) return line;
        const head = line.slice(0, range.end);
        const sep = range.end > range.start ? ' ' : '';
        return `${head}${sep}[[${target}]]${line.slice(range.end)}`;
    });
}

/**
 * Replace the task's text — the words between the marker and the metadata —
 * keeping the rest of the line byte for byte. A `[[link]]` the new text leaves
 * out is kept, appended where {@link linkTask} writes one, so rewording a
 * plan's root task can't drop its plan; `#tags` are words, so the new text
 * replaces them.
 */
export function rewordTask(lines: readonly string[], id: string, text: string): OpResult {
    if (/[\r\n]/.test(text)) throw new TaskOpError('a task is one line — the text has a newline');
    const words = text.replace(/\s+/g, ' ').trim();
    if (words === '') throw new TaskOpError('a task needs some text');
    if (words.includes('<!--'))
        throw new TaskOpError('the text cannot hold "<!--" — it would open a metadata comment');
    return editLine(lines, id, (line) => {
        const range = taskContentRange(line);
        if (!range) return line;
        const links = new Set(wikiLinkSpans(words).map((s) => s.path));
        let content = words;
        for (const { path } of wikiLinkSpans(line.slice(range.start, range.end))) {
            if (links.has(path)) continue;
            links.add(path);
            content += ` [[${path}]]`;
        }
        const after = `${line.slice(0, range.start)}${content}${line.slice(range.end)}`;
        // Text glued to the marker, or more text after the comment, would be cut or kept wrongly.
        if (parseLine(after)?.content !== content) {
            throw new TaskOpError(
                `@id:${id} isn't written "- [ ] text <!-- … -->" — change its text in an editor`,
            );
        }
        return after;
    });
}
