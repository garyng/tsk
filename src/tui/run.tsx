import fs from 'node:fs';
import path from 'node:path';
import { render } from 'ink';
import { onExit } from 'signal-exit';
import { readDoc, readOutside, treeWithOutside } from '../cli/store';
import { runtimeDir, tmuxOf } from '../lib/tui-channel';
import { wikiPathCandidates } from '../lib/wiki-link';
import { App, type TuiIo, type Who } from './app';
import { claudeConfigDir, followPid } from './follow';
import { tellSession, transcriptPath } from './inbox';
import { listenForRequests } from './listen';
import { mouseReporting } from './mouse';
import { EXTENDED_KEYS_OFF, EXTENDED_KEYS_ON } from './note-editor';
import { openInVsCode } from './open-in-vscode';
import { darkFromColorFgBg, isDark, queryBackground } from './terminal-background';

/** Writers rename a temp file over the target in a burst of events; redraw once they settle. */
const RELOAD_DEBOUNCE_MS = 50;
/** How often to re-read which session the followed Claude is on. */
const FOLLOW_POLL_MS = 1000;

export interface TuiOptions {
    readonly file: string;
    /** Pin one session. */
    readonly session?: string;
    /** Follow a running Claude Code process: whichever session it's on now. */
    readonly followPid?: number;
    /** Ask the terminal for mouse reports; false leaves its own text selection alone. */
    readonly mouse: boolean;
    readonly env: NodeJS.ProcessEnv;
}

/**
 * Watch the file's directory, not the file: every CLI write renames a temp
 * file over it, and a watch on the file follows the old inode and goes quiet
 * after the first one.
 */
function watchFile(
    file: string,
    onChange: () => void,
    matches = (name: string) => name === path.basename(file),
): () => void {
    let timer: NodeJS.Timeout | undefined;
    const watcher = fs.watch(path.dirname(file), (_event, changed) => {
        if (changed !== null && !matches(changed)) return;
        clearTimeout(timer);
        timer = setTimeout(onChange, RELOAD_DEBOUNCE_MS);
    });
    return () => {
        clearTimeout(timer);
        watcher.close();
    };
}

/**
 * Where a `[[path]]` link in the `.tsk` file points: beside the file first
 * (a `claude.tsk` at a repository's root links `docs/…`), then the working directory.
 */
function linkCandidates(link: string, file: string): string[] {
    return wikiPathCandidates(link, path.dirname(path.resolve(file)), process.cwd());
}

export async function runTui(opts: TuiOptions): Promise<number> {
    const configDir = claudeConfigDir(opts.env);
    // https://no-color.org: any non-empty value. Ink's chalk doesn't read it.
    const color = !opts.env.NO_COLOR;
    // Asked before Ink reads stdin, so the reply can't arrive as keys.
    const background = color ? await queryBackground(process.stdin, process.stdout) : undefined;
    const dark = background ? isDark(background) : (darkFromColorFgBg(opts.env.COLORFGBG) ?? true);
    let last: Who = { session: opts.session };
    let warnings: readonly string[] = [];
    let unhookKeys: (() => void) | undefined;
    const io: TuiIo = {
        fileName: path.basename(opts.file),
        load: () => {
            const outside = readOutside(opts.file);
            warnings = outside.warnings;
            return treeWithOutside(readDoc(opts.file).lines, outside.files);
        },
        warnings: () => warnings,
        // The files beside it too: a task here can wait on one of theirs.
        watch: (onChange) => watchFile(opts.file, onChange, (name) => name.endsWith('.tsk')),
        who: () => {
            if (opts.followPid === undefined) return last;
            const f = followPid(opts.followPid, configDir);
            // When the Claude is gone, keep showing the session it was last on.
            last = { session: f.session ?? last.session, note: f.status };
            return last;
        },
        pollMs: FOLLOW_POLL_MS,
        open: (node) => openInVsCode(opts.file, node.task.line, opts.env),
        readLinked: (link) => {
            const candidates = linkCandidates(link, opts.file);
            const file = candidates.find((c) => fs.existsSync(c));
            if (!file) throw new Error(`not found (looked for ${candidates.join(', ')})`);
            return { file, text: fs.readFileSync(file, 'utf8') };
        },
        watchLinked: (link, onChange) => {
            // A link that doesn't resolve has nothing to watch; readLinked says why in the pane.
            const file = linkCandidates(link, opts.file).find((c) => fs.existsSync(c));
            return file ? watchFile(file, onChange) : () => {};
        },
        openFile: (file, line) => openInVsCode(file, line, opts.env),
        color,
        backdrop: { background, dark },
        extendedKeys: (on) => {
            if (!process.stdout.isTTY) return;
            process.stdout.write(on ? EXTENDED_KEYS_ON : EXTENDED_KEYS_OFF);
            // Left on, the shell the pane falls back to would get shift+enter and the like as escape codes.
            unhookKeys?.();
            unhookKeys = on
                ? onExit(() => {
                      process.stdout.write(EXTENDED_KEYS_OFF);
                  })
                : undefined;
        },
        tell:
            opts.followPid === undefined
                ? undefined
                : (text, onDelivery) => {
                      const f = followPid(opts.followPid as number, configDir);
                      if (!f.alive) return Promise.reject(new Error(f.status));
                      if (!f.socket) {
                          const why = 'it has no inbox socket (needs Claude Code 2.1.224+)';
                          return Promise.reject(new Error(why));
                      }
                      const sessionId = f.sessionId;
                      return tellSession(
                          {
                              socket: f.socket,
                              transcript: () =>
                                  sessionId ? transcriptPath(configDir, sessionId) : undefined,
                              pid: process.pid,
                              pollMs: FOLLOW_POLL_MS,
                          },
                          text,
                          onDelivery,
                      );
                  },
        requests: (onSelect, onError) => {
            let stop: (() => void) | undefined;
            let stopped = false;
            listenForRequests({
                dir: runtimeDir(opts.env),
                shows: {
                    file: fs.realpathSync(opts.file),
                    followPid: opts.followPid,
                    session: opts.session,
                    tmux: tmuxOf(opts.env),
                },
                onSelect,
                onError,
            }).then((s) => {
                if (stopped) s();
                else stop = s;
            }, onError);
            return () => {
                stopped = true;
                stop?.();
            };
        },
    };
    const stopMouse =
        opts.mouse && process.stdout.isTTY ? mouseReporting(process.stdout) : undefined;
    try {
        const app = render(<App io={io} />, { alternateScreen: true });
        await app.waitUntilExit();
    } finally {
        stopMouse?.();
    }
    return 0;
}
