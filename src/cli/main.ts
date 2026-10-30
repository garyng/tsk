import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { dependsOnIds, readyTasks } from '../lib/dependencies';
import { parseIdList } from '../lib/relationships';
import {
    agentOf,
    isOpen,
    sessionFocus,
    sessionOf,
    sessionTrail,
    shortSessionId,
} from '../lib/session-focus';
import {
    addDependencies,
    addTask,
    defaultOpsDeps,
    delegateTask,
    findNode,
    finishTask,
    focusTask,
    linkTask,
    type OpResult,
    type OpsDeps,
    parkTask,
    removeDependencies,
    rewordTask,
    TaskOpError,
} from '../lib/task-ops';
import {
    buildTaskTree,
    type OutsideFile,
    pathTo,
    subtreeNodes,
    type TaskTree,
    type TreeNode,
} from '../lib/task-tree';
import { formatList, formatReady, formatShow, formatTrail, label } from './format';
import { selectClicked, type Tmux } from './select-clicked';
import { sessionStart } from './session-hook';
import { showInTui } from './show-in-tui';
import { readDoc, readOutside, StoreError, treeWithOutside, updateDoc } from './store';
import { idsAsRefs } from './terminal-ids';

/**
 * `tsk` — the command line that agent sessions (and people) use to track work
 * in a `.tsk` file. Every change goes through {@link updateDoc} (lock, re-read,
 * atomic write) and the pure operations in `lib/task-ops.ts`.
 */

/** The file `tsk` looks for, walking up from the working directory, when none is named. */
export const DEFAULT_FILE_NAME = 'claude.tsk';

export const USAGE = `tsk: track work in a .tsk file

  tsk trail                         where this session is: root → focus, what's still open
  tsk push <text> [--link <path>]   start a sidetrack under the focus, and focus it
  tsk add <text> [--under <id> | --root] [--link <path>]
                                    queue a task for later (default: under the focus)
  tsk delegate <id> --to <name>     hand <id> to a subagent or teammate; the focus stays
                                    (push and add take --to too)
  tsk focus <id>                    work on <id> now (takes it back from an agent)
  tsk done [<id>]                   finish <id> (default: the focus); focus falls back to its parent
  tsk park [<id>]                   put <id> back to [ ] for later (default: the focus)
  tsk cancel <id>
  tsk dep <id> --on <other>…        <id> can't start until <other> is done (repeat --on, or a,b)
  tsk dep <id> --off <other>…       drop those dependencies
  tsk ready [<id>] [--all]          what can start now: under the focus's top-level task, <id>,
                                    or the whole file (--all)
  tsk link <id> <path>              add a [[path]] link to the task
  tsk reword <id> <text>            change the task's text; its [[links]] and metadata stay
  tsk show <id> [--tui]             a task, the path down to it, and its children
                                    (--tui: select it in the TUI beside this Claude instead)
  tsk ls [--all]                    this session's tasks in their tree (--all: every task)
  tsk tui [--follow-pid <pid>]      a live view in the terminal; follows a Claude Code process's session
          [--no-mouse]              leave the mouse to the terminal (or TSK_NO_MOUSE)
  tsk session start                 Claude Code's SessionStart hook (reads the hook input on stdin)
  tsk select-clicked --pane=<%n> --client=<name> --column=<n> --line=<text> [--hyperlink=<uri>]
                                    tmux's Ctrl+Click: select the tsk:<id> under the mouse in the
                                    TUI beside that pane

options:
  --file <path>     the .tsk file (or TSK_FILE; default: the nearest ${DEFAULT_FILE_NAME} above the working directory)
  --session <id>    the session (or TSK_SESSION, else CLAUDE_CODE_SESSION_ID); first 8 characters kept`;

export interface CliIo {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly cwd: string;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
    readonly readStdin?: () => Promise<string>;
    readonly deps?: OpsDeps;
    /** The output is a terminal: each task's id is printed as a coloured `tsk:<id>` (`terminal-ids.ts`). */
    readonly terminal?: boolean;
    /** Runs tmux, for `select-clicked`; tests stand one in. */
    readonly tmux?: Tmux;
}

class UsageError extends Error {}

export function resolveFile(flag: string | undefined, env: CliIo['env'], cwd: string): string {
    const named = flag ?? env.TSK_FILE;
    if (named) return path.resolve(cwd, named);
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, DEFAULT_FILE_NAME);
        if (fs.existsSync(candidate)) return candidate;
        if (path.dirname(dir) === dir) break;
    }
    throw new UsageError(
        `no ${DEFAULT_FILE_NAME} in ${cwd} or above it; create one, or pass --file or set TSK_FILE`,
    );
}

export function resolveSession(flag: string | undefined, env: CliIo['env']): string | undefined {
    const id = flag ?? env.TSK_SESSION ?? env.CLAUDE_CODE_SESSION_ID;
    return id ? shortSessionId(id) : undefined;
}

export async function main(given: CliIo): Promise<number> {
    // Any NO_COLOR but an empty one turns colour off (https://no-color.org).
    const colour = !given.env.NO_COLOR;
    const io = given.terminal
        ? { ...given, out: (text: string) => given.out(idsAsRefs(text, colour)) }
        : given;
    const deps = io.deps ?? defaultOpsDeps;
    try {
        const { values, positionals } = parseArgs({
            args: [...io.argv],
            allowPositionals: true,
            options: {
                file: { type: 'string' },
                session: { type: 'string' },
                under: { type: 'string' },
                root: { type: 'boolean' },
                link: { type: 'string' },
                to: { type: 'string' },
                on: { type: 'string', multiple: true },
                off: { type: 'string', multiple: true },
                all: { type: 'boolean' },
                'follow-pid': { type: 'string' },
                'no-mouse': { type: 'boolean' },
                tui: { type: 'boolean' },
                pane: { type: 'string' },
                client: { type: 'string' },
                column: { type: 'string' },
                line: { type: 'string' },
                hyperlink: { type: 'string' },
                help: { type: 'boolean', short: 'h' },
            },
        });
        const [command, ...args] = positionals;
        if (values.help || command === undefined || command === 'help') {
            io.out(USAGE);
            return 0;
        }
        if (command === 'session') {
            if (args[0] !== 'start')
                throw new UsageError('session: the only subcommand is `start`');
            const input = (await io.readStdin?.()) ?? '';
            const hookCwd = (JSON.parse(input || '{}') as { cwd?: string }).cwd ?? io.cwd;
            let hookFile: string | undefined;
            try {
                hookFile = resolveFile(values.file, io.env, hookCwd);
            } catch (e) {
                if (!(e instanceof UsageError)) throw e;
            }
            const output = await sessionStart({
                input,
                env: io.env,
                file: hookFile,
                now: Date.now(),
            });
            if (output) io.out(output);
            return 0;
        }
        if (command === 'select-clicked') {
            // Before the file: tmux runs it in its own working directory, and each TUI knows its file.
            const { pane, client, line } = values;
            const column = Number(values.column);
            if (!pane || !client || line === undefined || !Number.isInteger(column)) {
                throw new UsageError('select-clicked: needs --pane, --client, --column and --line');
            }
            const click = { pane, client, column, line, hyperlink: values.hyperlink || undefined };
            return await selectClicked(click, io);
        }
        const file = resolveFile(values.file, io.env, io.cwd);
        const session = resolveSession(values.session, io.env);
        let besides: OutsideFile[] | undefined;
        /** The `.tsk` files beside this one, read once, for the ids it names but doesn't have. */
        const outside = (): OutsideFile[] => {
            if (!besides) {
                const read = readOutside(file);
                for (const w of read.warnings) io.err(`tsk: ${w}`);
                besides = read.files;
            }
            return besides;
        };
        /** The file as a tree, its dependencies looked up beside it too. */
        const load = () => treeWithOutside(readDoc(file).lines, outside());
        const needSession = (): string => {
            if (!session)
                throw new UsageError(
                    'no session; pass --session, set TSK_SESSION, or run inside Claude Code',
                );
            return session;
        };
        const arg = (i: number, what: string): string => {
            const v = args[i];
            if (v === undefined || v === '') throw new UsageError(`${command}: missing ${what}`);
            return v;
        };
        const focusId = (tree: TaskTree): string => {
            const s = needSession();
            const focus = sessionFocus(tree, s);
            if (!focus?.id) throw new TaskOpError(`no focus for session ${s}; name the task`);
            return focus.id;
        };
        /** Run one operation under the lock; report the task, and on request its parent, agent, or the focus after it. */
        const change = async (
            op: (lines: readonly string[]) => OpResult,
            verb: string,
            report: { parent?: boolean; agent?: boolean; focus?: boolean; deps?: boolean } = {},
        ) => {
            const text = await updateDoc(file, (lines) => {
                const res = op(lines);
                const tree = buildTaskTree(res.lines);
                const node = findNode(tree, res.id);
                let out = `${res.changed ? verb : `${verb} (no change)`}  ${label(node)}`;
                if (report.parent && node.parent) out += `  (under ${node.parent.id})`;
                if (report.agent) out += `  (to ${agentOf(node)})`;
                if (report.deps) {
                    const ids = dependsOnIds(node);
                    out +=
                        ids.length > 0 ? `  (depends on ${ids.join(', ')})` : '  (no dependencies)';
                }
                if (report.focus && session) {
                    const f = sessionFocus(tree, session);
                    out += `\nfocus  ${f ? label(f) : '(none)'}`;
                }
                return { lines: res.changed ? res.lines : undefined, result: out };
            });
            io.out(text);
        };

        switch (command) {
            case 'trail': {
                const s = needSession();
                const tree = load();
                io.out(formatTrail(sessionTrail(tree, s), s, tree));
                return 0;
            }
            case 'push':
            case 'add': {
                const text = [arg(0, 'the task text'), ...args.slice(1)].join(' ');
                const push = command === 'push';
                const agent = values.to;
                if (push || agent !== undefined) needSession();
                await change(
                    (lines) => {
                        const tree = buildTaskTree(lines);
                        const parentId = values.root
                            ? undefined
                            : (values.under ??
                              (session ? sessionFocus(tree, session)?.id : undefined));
                        let res = addTask(
                            lines,
                            { text, parentId, start: push, agent, session },
                            deps,
                        );
                        if (values.link)
                            res = { ...linkTask(res.lines, res.id, values.link), changed: true };
                        return res;
                    },
                    push ? 'pushed' : 'added',
                    { parent: true, agent: agent !== undefined, focus: agent !== undefined },
                );
                return 0;
            }
            case 'delegate': {
                const id = arg(0, 'the task id');
                const agent = values.to;
                if (agent === undefined)
                    throw new UsageError('delegate: name the agent with --to <name>');
                const s = needSession();
                await change((lines) => delegateTask(lines, id, agent, s, deps), 'delegated', {
                    agent: true,
                    focus: true,
                });
                return 0;
            }
            case 'focus': {
                const id = arg(0, 'the task id');
                await change((lines) => focusTask(lines, id, session, deps), 'focus');
                return 0;
            }
            case 'done':
            case 'cancel':
            case 'park': {
                const named = args[0];
                if (command === 'cancel' && !named)
                    throw new UsageError('cancel: missing the task id');
                await change(
                    (lines) => {
                        const id = named ?? focusId(buildTaskTree(lines));
                        if (command === 'park') return parkTask(lines, id);
                        return finishTask(
                            lines,
                            id,
                            command === 'done' ? 'completed' : 'cancelled',
                            deps,
                        );
                    },
                    command === 'done' ? 'done' : command === 'park' ? 'parked' : 'cancelled',
                    { focus: true },
                );
                return 0;
            }
            case 'dep': {
                const id = arg(0, 'the task id');
                const on = parseIdList(values.on?.join(','));
                const off = parseIdList(values.off?.join(','));
                if (on.length === 0 && off.length === 0)
                    throw new UsageError('dep: name the dependencies with --on <id> or --off <id>');
                await change(
                    (lines) => {
                        const added = addDependencies(lines, id, on, outside());
                        const removed = removeDependencies(added.lines, id, off);
                        return { ...removed, changed: added.changed || removed.changed };
                    },
                    'dep',
                    { deps: true },
                );
                return 0;
            }
            case 'ready': {
                const tree = load();
                let scope: TreeNode | undefined;
                if (args[0]) scope = findNode(tree, args[0]);
                else if (!values.all && session) {
                    const focus = sessionFocus(tree, session);
                    scope = focus ? pathTo(focus)[0] : undefined;
                }
                const inScope = scope ? subtreeNodes(scope) : tree.nodes;
                io.out(formatReady(tree, readyTasks(tree, scope), scope, inScope));
                return 0;
            }
            case 'link': {
                const id = arg(0, 'the task id');
                const target = arg(1, 'the path');
                await change((lines) => linkTask(lines, id, target), 'linked');
                return 0;
            }
            case 'reword': {
                const id = arg(0, 'the task id');
                const text = [arg(1, 'the new text'), ...args.slice(2)].join(' ');
                await change((lines) => rewordTask(lines, id, text), 'reworded');
                return 0;
            }
            case 'tui': {
                const raw = values['follow-pid'];
                const followPid = raw === undefined ? undefined : Number(raw);
                if (followPid !== undefined && !Number.isInteger(followPid)) {
                    throw new UsageError(`tui: --follow-pid needs a process id, not "${raw}"`);
                }
                // Loaded on demand, so the other commands don't pay for Ink and React at start-up.
                const { runTui } = await import('../tui/run');
                const pinned = values.session ? resolveSession(values.session, {}) : undefined;
                return await runTui({
                    file,
                    followPid,
                    session: pinned ?? (followPid ? undefined : session),
                    // Any value but an empty one opts out, as NO_COLOR does.
                    mouse: !values['no-mouse'] && !io.env.TSK_NO_MOUSE,
                    env: { ...io.env },
                });
            }
            case 'show': {
                const id = arg(0, 'the task id');
                const tree = load();
                const node = findNode(tree, id);
                if (values.tui) return await showInTui(id, node, file, session, io);
                io.out(formatShow(tree, node));
                return 0;
            }
            case 'ls': {
                const tree = load();
                if (values.all) io.out(formatList(tree));
                else {
                    const s = needSession();
                    io.out(formatList(tree, (n) => sessionOf(n) === s && isOpen(n.task.marker)));
                }
                return 0;
            }
            default:
                throw new UsageError(`unknown command "${command}"; see tsk --help`);
        }
    } catch (e) {
        if (e instanceof UsageError || e instanceof TaskOpError || e instanceof StoreError) {
            io.err(`tsk: ${e.message}`);
            return 1;
        }
        if (
            e instanceof TypeError &&
            (e as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')
        ) {
            io.err(`tsk: ${e.message}; see tsk --help`);
            return 1;
        }
        io.err(`tsk: unexpected error: ${(e as Error).stack ?? e}`);
        return 2;
    }
}
