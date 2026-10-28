import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from './main';

let dir: string;
let handover: string;
let file: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsk-hook-'));
    handover = path.join(dir, 'handover');
    fs.mkdirSync(handover);
    file = path.join(dir, 'claude.tsk');
    fs.writeFileSync(
        file,
        [
            '- [/] the plan <!-- @id:p @session:oldsess1 @focused:2026-10-19T10:00:00+00:00 -->',
            '  - [ ] queued <!-- @id:q @session:oldsess1 -->',
            '  - [x] finished <!-- @id:f @session:oldsess1 -->',
            '',
        ].join('\n'),
    );
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The SessionEnd one-liner: save the hook's input as this pid's note. */
function endSession(pid: string, sessionId: string, ageMs = 0) {
    const note = path.join(handover, `${pid}.json`);
    fs.writeFileSync(note, JSON.stringify({ session_id: sessionId, reason: 'clear' }));
    if (ageMs > 0) {
        const then = new Date(Date.now() - ageMs);
        fs.utimesSync(note, then, then);
    }
}

async function startSession(source: string, sessionId: string, pid = '4242', cwd = dir) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main({
        argv: ['session', 'start'],
        env: { CLAUDE_PID: pid, TSK_HANDOVER_DIR: handover },
        cwd: '/',
        out: (s) => out.push(s),
        err: (s) => err.push(s),
        readStdin: async () => JSON.stringify({ session_id: sessionId, source, cwd }),
    });
    const context =
        out.length > 0 ? JSON.parse(out.join('')).hookSpecificOutput.additionalContext : undefined;
    return { code, context: context as string | undefined, err: err.join('\n') };
}

const sessions = () =>
    [...fs.readFileSync(file, 'utf8').matchAll(/@session:(\w+)/g)].map((m) => m[1]);

describe('tsk session start', () => {
    it('on /clear, carries the open tasks over from the session that just ended, and hands back the trail', async () => {
        endSession('4242', 'oldsess1-0000-uuid');
        const { code, context } = await startSession('clear', 'newsess2-0000-uuid');
        expect(code).toBe(0);
        expect(sessions()).toEqual(['newsess2', 'newsess2', 'oldsess1']);
        expect(context).toContain('Carried 2 open task(s) over from session oldsess1');
        expect(context).toContain('1 [/] p the plan  ← focus');
        expect(fs.existsSync(path.join(handover, '4242.json'))).toBe(false);
    });

    it('carries on /branch (source fork) too', async () => {
        endSession('4242', 'oldsess1-0000-uuid');
        await startSession('fork', 'newsess2-0000-uuid');
        expect(sessions()).toEqual(['newsess2', 'newsess2', 'oldsess1']);
    });

    it('ignores a stale note — a reused pid — but still removes it', async () => {
        endSession('4242', 'oldsess1-0000-uuid', 5 * 60_000);
        const { context } = await startSession('clear', 'newsess2-0000-uuid');
        expect(sessions()).toEqual(['oldsess1', 'oldsess1', 'oldsess1']);
        expect(context).toBeUndefined();
        expect(fs.existsSync(path.join(handover, '4242.json'))).toBe(false);
    });

    it('never carries on compact or resume, but hands back the trail', async () => {
        endSession('4242', 'someone-else');
        const { context } = await startSession('compact', 'oldsess1-0000-uuid');
        expect(sessions()).toEqual(['oldsess1', 'oldsess1', 'oldsess1']);
        expect(context).toContain('trail (session oldsess1)');
        expect(context).not.toContain('Carried');
    });

    it("ignores another pid's note", async () => {
        endSession('1111', 'oldsess1-0000-uuid');
        await startSession('clear', 'newsess2-0000-uuid', '4242');
        expect(sessions()).toEqual(['oldsess1', 'oldsess1', 'oldsess1']);
        expect(fs.existsSync(path.join(handover, '1111.json'))).toBe(true);
    });

    it('hands back the trail when the only open tasks are with agents', async () => {
        fs.writeFileSync(file, '- [/] probe <!-- @id:a @session:agentss1 @agent:alpha -->\n');
        const { context } = await startSession('compact', 'agentss1-0000-uuid');
        expect(context).toContain('with agents:\n    [/] a probe  (alpha)');
    });

    it('says nothing for a session with no tasks, or a project without a claude.tsk', async () => {
        expect((await startSession('compact', 'nobody00-uuid')).context).toBeUndefined();
        const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tsk-bare-'));
        try {
            expect(await startSession('clear', 'newsess2-uuid', '4242', bare)).toMatchObject({
                code: 0,
                context: undefined,
            });
        } finally {
            fs.rmSync(bare, { recursive: true, force: true });
        }
    });
});

describe('tsk session start, with a file beside it', () => {
    it('reads what the trail waits on there, and says what it could not read', async () => {
        fs.writeFileSync(
            file,
            [
                '- [/] the plan <!-- @id:p @session:sess0003 @focused:2026-10-19T10:00:00+00:00 -->',
                '  - [ ] on done <!-- @id:d @session:sess0003 @dependsOn:x -->',
                '  - [ ] on open <!-- @id:o @session:sess0003 @dependsOn:y -->',
            ].join('\n'),
        );
        fs.writeFileSync(
            path.join(dir, 'stack.tsk'),
            '- [x] done <!-- @id:x -->\n- [ ] open <!-- @id:y -->',
        );
        fs.writeFileSync(path.join(dir, 'locked.tsk'), '');
        fs.chmodSync(path.join(dir, 'locked.tsk'), 0o000);
        const { context } = await startSession('startup', 'sess0003-0000-uuid');
        expect(context).toContain('    [ ] d on done\n');
        expect(context).toContain('    [ ] o on open  (waits on y)');
        expect(context).toMatch(/\ntsk: couldn't read locked\.tsk: EACCES/);
    });
});
