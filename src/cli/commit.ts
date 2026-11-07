import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitMessage, fileChanges } from '../lib/task-changes';
import { splitDoc } from './store';

export interface CommitIo {
    /** Also git's environment. */
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
}

class GitError extends Error {}

/**
 * `tsk commit`: commit the `.tsk` file whole, as it
 * stands, with a message naming what changed in each session's tasks. Every
 * tsk write renames a whole file into place, so the file is always a state
 * some session wrote, which a commit of one session's lines can't promise.
 *
 * Through a private index read from `HEAD`, so nothing anyone else staged
 * goes in with it: the index belongs to the checkout, not to one session.
 * The git command line does the work rather than a library: the commit runs
 * the repository's hooks and follows its config as `git commit` would.
 */
export function commitTaskFile(file: string, io: CommitIo): number {
    const real = fs.realpathSync(file);
    const git = (args: readonly string[], opts: { index?: string; input?: string } = {}) => {
        try {
            return execFileSync('git', args, {
                cwd: path.dirname(real),
                env: opts.index ? { ...io.env, GIT_INDEX_FILE: opts.index } : io.env,
                input: opts.input ?? '',
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (e) {
            const why = ((e as { stderr?: string }).stderr ?? '').trim();
            throw new GitError(why || (e as Error).message);
        }
    };
    const succeeds = (args: readonly string[]) => {
        try {
            git(args);
            return true;
        } catch (e) {
            if (e instanceof GitError) return false;
            throw e;
        }
    };

    if (!succeeds(['rev-parse', '--show-toplevel'])) {
        io.err(`tsk: ${real} isn't in a git repository`);
        return 1;
    }
    const top = git(['rev-parse', '--show-toplevel']).trim();
    const rel = path.relative(top, real).split(path.sep).join('/');
    if (succeeds(['check-ignore', '-q', '--', rel])) {
        io.err(`tsk: git ignores ${rel}`);
        return 1;
    }
    const hasHead = succeeds(['rev-parse', '-q', '--verify', 'HEAD']);
    const inHead = hasHead && succeeds(['cat-file', '-e', `HEAD:${rel}`]);
    const before = inHead ? git(['show', `HEAD:${rel}`]) : '';
    const text = fs.readFileSync(real, 'utf8');
    if (inHead && text === before) {
        io.out(`nothing to commit: ${rel} matches HEAD`);
        return 0;
    }

    const message = commitMessage(
        path.basename(rel),
        fileChanges(inHead ? splitDoc(before).lines : [], splitDoc(text).lines),
    );
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsk-commit-'));
    const index = path.join(tmp, 'index');
    try {
        const blob = git(['hash-object', '-w', '--stdin'], { input: text }).trim();
        git(hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { index });
        git(['update-index', '--add', '--cacheinfo', `100644,${blob},${rel}`], { index });
        const said = git(['commit', '-q', '-F', '-'], { index, input: message });
        if (said.trim()) io.err(said.trim());
    } catch (e) {
        if (!(e instanceof GitError)) throw e;
        io.err(`tsk: git commit failed: ${e.message}`);
        return 1;
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    // The shared index still holds the old blob, which would read as a staged revert.
    try {
        git(['reset', '-q', 'HEAD', '--', rel]);
    } catch (e) {
        if (!(e instanceof GitError)) throw e;
        io.err(`tsk: committed, but ${rel} still reads as staged: ${e.message}`);
    }
    const sha = git(['rev-parse', '--short', 'HEAD']).trim();
    io.out(`committed ${rel} as ${sha}: ${message.split('\n')[0]}`);
    return 0;
}
