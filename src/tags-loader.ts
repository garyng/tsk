import { basename, dirname } from 'node:path';
import * as vscode from 'vscode';
import { TAGS_PATH_KEY, TAGS_PATH_SETTING } from './constants';
import type { Logger } from './lib/logger';
import { parseTagsYaml, type TagDef } from './lib/tags-config';
import { resolveTagsPath } from './lib/tags-path';

/**
 * Read-only handle on the workspace's `tags.yml` state. Returned from
 * `createTagsLoader`. The map is replaced wholesale on each reload — no
 * mutation of the existing reference — so callers can safely cache the
 * map between reads, but must re-read to see updates.
 */
export interface TagsLoader {
    getTags(): ReadonlyMap<string, TagDef>;
    /**
     * Re-read the configured `tags.yml` and replace the internal state.
     * Surface in case the activation layer wants to trigger a reload
     * outside of the watcher / setting-change events (e.g. retry after a
     * transient FS error).
     */
    reload(): Promise<void>;
}

/**
 * Build a `TagsLoader` for the active workspace. Wires the FileSystemWatcher
 * + the configuration-change listener so the internal state stays current
 * without the activation file having to remember to call `reload()`.
 *
 * Disposal: every long-lived resource (watcher, config listener) is added
 * to `context.subscriptions`, so deactivation tears them all down. The
 * watcher is replaced (and the old one disposed) when the `tsk.tags.path`
 * setting changes.
 */
export async function createTagsLoader(
    context: vscode.ExtensionContext,
    logger: Logger,
): Promise<TagsLoader> {
    let state: ReadonlyMap<string, TagDef> = new Map();
    let currentWatcher: vscode.FileSystemWatcher | undefined;

    function resolvePath(): string | undefined {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const raw = vscode.workspace.getConfiguration('tsk').get<string>(TAGS_PATH_KEY, '');
        return resolveTagsPath(raw, workspaceFolder);
    }

    async function reload(): Promise<void> {
        const path = resolvePath();
        if (!path) {
            state = new Map();
            return;
        }
        try {
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
            const text = new TextDecoder().decode(bytes);
            const parsed = parseTagsYaml(text);
            if (parsed.size === 0) {
                logger.warn(`tags.yml at ${path} parsed to empty.`);
            } else {
                logger.info(`tags.yml at ${path} loaded with ${parsed.size} tag(s).`);
            }
            state = parsed;
        } catch (err) {
            const code = (err as { code?: string }).code;
            if (code === 'FileNotFound') {
                // Expected — the file may not exist yet. Watcher will pick
                // it up on create.
                state = new Map();
                return;
            }
            logger.error(`failed to read tags.yml at ${path}: ${(err as Error).message}`);
            state = new Map();
        }
    }

    function rebuildWatcher(): void {
        currentWatcher?.dispose();
        currentWatcher = undefined;
        const path = resolvePath();
        if (!path) return;
        // RelativePattern with an absolute base lets us watch a single file
        // anywhere on disk, even outside the active workspace folder. The
        // typical case is `${workspaceFolder}/.vscode/tsk/tags.yml`, but
        // users can point at an absolute path and still get watcher events.
        const pattern = new vscode.RelativePattern(vscode.Uri.file(dirname(path)), basename(path));
        currentWatcher = vscode.workspace.createFileSystemWatcher(pattern);
        currentWatcher.onDidCreate(() => void reload());
        currentWatcher.onDidChange(() => void reload());
        currentWatcher.onDidDelete(() => {
            state = new Map();
            logger.info('tags.yml deleted; cleared in-memory tag defs.');
        });
    }

    rebuildWatcher();
    await reload();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (!event.affectsConfiguration(TAGS_PATH_SETTING)) return;
            const newPath = resolvePath();
            logger.info(`${TAGS_PATH_SETTING} changed; resolved to ${newPath ?? '(none)'}.`);
            rebuildWatcher();
            void reload();
        }),
        { dispose: () => currentWatcher?.dispose() },
    );

    return {
        getTags: () => state,
        reload,
    };
}
