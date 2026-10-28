import fs from 'node:fs';
import path from 'node:path';
import { sessionTrail, shortSessionId } from '../lib/session-focus';
import { handOverSession } from '../lib/task-ops';
import { formatTrail } from './format';
import { readDoc, readOutside, treeWithOutside, updateDoc } from './store';

/**
 * `tsk session start` — Claude Code's SessionStart hook. Two jobs:
 *
 * 1. **Carry the pane's open tasks over** when `/clear` or `/branch` gives the
 *    conversation a new session id inside the same process. SessionStart's
 *    input doesn't name the old id, but the SessionEnd hook fires just before
 *    it with the old id and the same `CLAUDE_PID`, and saves its input as a
 *    hand-over note: `<hand-over dir>/<pid>.json` (a shell one-liner in
 *    `.claude/settings.json`, so ending a session costs no Node start-up).
 * 2. **Hand Claude its trail** as additional context, so a compacted, resumed,
 *    cleared or branched conversation knows where it was.
 *
 * A note counts only when it is fresh: SessionEnd and SessionStart fire within
 * moments of each other, and an older note may come from an exited Claude
 * whose pid has since been reused. Every run removes this pid's note.
 */

/** Where the SessionEnd hook leaves its note. Must match `.claude/settings.json`. */
export const DEFAULT_HANDOVER_DIR = '/tmp/tsk-handover';
/** A note older than this is somebody else's. */
const HANDOVER_MAX_AGE_MS = 60_000;
/** SessionStart sources whose new session id replaced one in the same process. */
const CARRY_SOURCES = new Set(['clear', 'fork']);

interface HookInput {
    session_id?: string;
    source?: string;
    cwd?: string;
}

export interface SessionStartIo {
    readonly input: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    /** The `.tsk` file, or undefined when the project has none (then the hook does nothing). */
    readonly file: string | undefined;
    readonly now: number;
}

/** Read and remove this pid's note; return the old session id if the note is fresh. */
function takeHandover(env: SessionStartIo['env'], now: number): string | undefined {
    const pid = env.CLAUDE_PID;
    if (!pid || !/^\d+$/.test(pid)) return undefined;
    const note = path.join(env.TSK_HANDOVER_DIR ?? DEFAULT_HANDOVER_DIR, `${pid}.json`);
    let text: string;
    let age: number;
    try {
        age = now - fs.statSync(note).mtimeMs;
        text = fs.readFileSync(note, 'utf8');
        fs.rmSync(note, { force: true });
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw e;
    }
    if (age > HANDOVER_MAX_AGE_MS) return undefined;
    const old = (JSON.parse(text) as HookInput).session_id;
    return old ? shortSessionId(old) : undefined;
}

/** The hook's stdout: SessionStart JSON with additional context, or nothing to say. */
export async function sessionStart(io: SessionStartIo): Promise<string | undefined> {
    const input = JSON.parse(io.input) as HookInput;
    if (!input.session_id) throw new Error('the SessionStart input has no session_id');
    const session = shortSessionId(input.session_id);
    const old = takeHandover(io.env, io.now);
    if (!io.file) return undefined;

    let carried = 0;
    if (old && old !== session && CARRY_SOURCES.has(input.source ?? '')) {
        carried = await updateDoc(io.file, (lines) => {
            const res = handOverSession(lines, old, session);
            return { lines: res.count > 0 ? res.lines : undefined, result: res.count };
        });
    }

    const outside = readOutside(io.file);
    const tree = treeWithOutside(readDoc(io.file).lines, outside.files);
    const trail = sessionTrail(tree, session);
    if (!trail.focus && trail.withAgents.length === 0 && trail.otherOpen.length === 0)
        return undefined;
    const context = [
        `tsk (${path.basename(io.file)}): this session's tasks.${carried > 0 ? ` Carried ${carried} open task(s) over from session ${old}.` : ''}`,
        formatTrail(trail, session, tree),
        ...outside.warnings.map((w) => `tsk: ${w}`),
        'Keep it current: `tsk push` for a sidetrack, `tsk add` to queue, `tsk done` / `tsk park` on the way back.',
    ].join('\n');
    return JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    });
}
