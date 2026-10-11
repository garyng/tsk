import { spawn } from 'node:child_process';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { FILE_SEARCH_EXCLUDE } from './constants';
import type { Logger } from './lib/logger';

/**
 * The list of workspace files tsk will look at: everything git does **not**
 * ignore. Backs both the `**​/*.tsk` scan and the `[[wiki link]]` candidates.
 *
 * **Why git and not `findFiles`.** Benchmarked in a real VS Code against a
 * ~100k-file monorepo (`task bench:file-search`, 1 cold + 5 warm runs):
 *
 * ```
 * findFiles('**​/*.tsk', '{**​/node_modules/**,**​/.git/**}')   798ms cold, 112ms warm
 * findFiles('**​/*.{md,tsk}', …)                                57ms cold,  49ms warm
 * git ls-files x2                                              13ms cold,  13ms warm
 * node:fs recursive walk                                      177ms cold, 199ms warm
 * ```
 *
 * `findFiles` is not slow *per query*. What activation logs kept showing as
 * 2-3s was contention: during extension-host startup everything runs an order
 * of magnitude or more slower than steady state (this same `ls-files` pair
 * measured 739ms there, against 13ms here). Git still wins — it's 8x cheaper
 * in steady state, never touches the search service, and answers the
 * gitignore question in the same call, so one subprocess pair replaces a query
 * plus a filter. (A hand-rolled `node:fs` walk is *slower*
 * than `findFiles` — ripgrep beats an in-process walk, so the
 * `workspace.fs`-vs-`node:fs` lesson does not generalise to directory
 * traversal.)
 *
 * **An allowlist, not a denylist, and that is load-bearing.** The obvious
 * approach is `git check-ignore --stdin` on candidate paths. It was tried and
 * abandoned: a *pathspec* makes git refuse the ENTIRE batch over one awkward
 * path, in two ways that are both common in real repositories —
 *
 * ```
 * fatal: Pathspec 'vendor/readme.md' is in submodule 'vendor'
 * fatal: pathspec '…/.venv/lib64/…/README.md' is beyond a symbolic link
 * ```
 *
 * `--no-index` fixes the first; nothing fixes the second (a Python venv's
 * `lib64 -> lib`). Asking what git *considers* needs no pathspec, so neither
 * fatal can happen — and it inherits exact gitignore semantics: nested
 * `.gitignore` files, `.git/info/exclude`, `core.excludesFile`, negation.
 *
 * Two calls, because `--others` and `--recurse-submodules` are mutually
 * exclusive (`fatal: ls-files --recurse-submodules unsupported mode`): one for
 * the parent repo, one for tracked files inside submodules.
 *
 * **Not cached.** 13ms on demand is cheaper than being wrong about staleness:
 * a cache would need invalidating on every file create and delete, not just on
 * a `.gitignore` edit, or a newly written file would be missing from the link
 * picker until reload.
 *
 * **Known limitation:** a file inside a submodule that is untracked but not
 * ignored appears in neither list, so it isn't offered until committed. The
 * alternative — passing unclassifiable paths through — was rejected because
 * the failure modes aren't symmetric: offering a stale file is a nuisance,
 * hiding a real one is a bug nobody notices.
 */
export class WorkspaceFiles {
    constructor(
        private readonly root: string,
        private readonly logger: Logger,
    ) {}

    /**
     * Every non-ignored file in the workspace. Falls back to `findFiles` with
     * `fallbackGlob` when git can't answer (no git on PATH, not a repository)
     * — a workspace without git still has to work, it just can't honour
     * ignore rules it has no source for.
     */
    async all(fallbackGlob: string): Promise<vscode.Uri[]> {
        try {
            const [own, submodules] = await Promise.all([
                this.lsFiles(['--cached', '--others', '--exclude-standard']),
                this.lsFiles(['--cached', '--recurse-submodules']),
            ]);
            const paths = new Set([...own, ...submodules]);
            this.logger.debug(`workspace files: ${paths.size} from git.`);
            return [...paths].map((path) => vscode.Uri.file(join(this.root, path)));
        } catch (err) {
            this.logger.warn(
                `git file listing unavailable (${(err as Error).message}); ` +
                    `falling back to a workspace search, which cannot honour .gitignore.`,
            );
            return [...(await vscode.workspace.findFiles(fallbackGlob, FILE_SEARCH_EXCLUDE))];
        }
    }

    /** `git ls-files -z <args>`, as paths relative to {@link root}. */
    private lsFiles(args: readonly string[]): Promise<string[]> {
        return new Promise((resolve, reject) => {
            // cwd = the workspace folder, so git scopes the listing to it and
            // reports paths relative to it — correct even when the workspace
            // is a subdirectory of a larger repository.
            const child = spawn('git', ['ls-files', '-z', ...args], { cwd: this.root });
            let stdout = '';
            let stderr = '';
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                stdout += chunk;
            });
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk: string) => {
                stderr += chunk;
            });
            child.on('error', reject);
            child.on('close', (code) => {
                if (code === 0) resolve(stdout.split('\0').filter((line) => line !== ''));
                else reject(new Error(stderr.trim() || `git ls-files exited ${code}`));
            });
        });
    }
}

/** Build the index for the first workspace folder, or `undefined` without one. */
export function createWorkspaceFiles(logger: Logger): WorkspaceFiles | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? new WorkspaceFiles(root, logger) : undefined;
}
