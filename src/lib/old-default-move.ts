import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Until 0.16 both databases defaulted to `<folder>/.vscode/tsk/`. One still
 * there, whose setting is at its new default, is dealt with once, on open:
 * the now-tree's `state.db` is copied to where it opens now (`VACUUM INTO`
 * takes in what's still in its `-wal`), and the cache is removed, since it's
 * rebuilt from the files. `.vscode/tsk`, then `.vscode`, go when that empties
 * them.
 */

export interface MoveLog {
    info(message: string): void;
    warn(message: string): void;
}

/** A setting no one has set, at any level: VS Code's `inspect` of it. */
export function isAtDefault(
    inspected:
        | { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }
        | undefined,
): boolean {
    return (
        inspected?.globalValue === undefined &&
        inspected?.workspaceValue === undefined &&
        inspected?.workspaceFolderValue === undefined
    );
}

const removeDatabase = (path: string) => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
};

/**
 * Deal with what the old defaults left in `folder`, for each database whose
 * setting is at its default: `to` holds where it opens now. Returns the old
 * `state.db` when it couldn't be copied, to open there this time instead;
 * otherwise undefined.
 */
export function moveOldDefaults(
    folder: string,
    to: { readonly cache?: string; readonly state?: string },
    log: MoveLog,
): string | undefined {
    const dir = join(folder, '.vscode', 'tsk');
    let removed = false;
    let openOld: string | undefined;

    const oldCache = join(dir, 'cache.db');
    if (to.cache && existsSync(oldCache)) {
        try {
            removeDatabase(oldCache);
            removed = true;
            log.info(`removed the cache at ${oldCache}; it's built at ${to.cache} now.`);
        } catch (e) {
            log.warn(`couldn't remove the old cache at ${oldCache}: ${e}`);
        }
    }

    const oldState = join(dir, 'state.db');
    if (to.state && existsSync(oldState)) {
        if (existsSync(to.state)) {
            log.warn(
                `a now-tree is at both ${oldState} and ${to.state}: ${to.state} is used, and ${oldState} is left as it is.`,
            );
        } else {
            try {
                mkdirSync(dirname(to.state), { recursive: true });
                const db = new DatabaseSync(oldState);
                try {
                    db.prepare('VACUUM INTO ?').run(to.state);
                } finally {
                    db.close();
                }
                removeDatabase(oldState);
                removed = true;
                log.info(`moved the now-tree from ${oldState} to ${to.state}.`);
            } catch (e) {
                // Whatever was copied goes; the old one stays, and is tried again next time.
                removeDatabase(to.state);
                openOld = oldState;
                log.warn(
                    `couldn't move the now-tree from ${oldState} to ${to.state}, so it opens where it was: ${e}`,
                );
            }
        }
    }

    if (removed) {
        for (const d of [dir, dirname(dir)]) {
            try {
                if (readdirSync(d).length > 0) break;
                rmdirSync(d);
            } catch (e) {
                log.warn(`couldn't remove the emptied ${d}: ${e}`);
                break;
            }
        }
    }
    return openOld;
}
