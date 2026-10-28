/**
 * Which cached `.tsk` files to drop, by URI string. The
 * cache holds the files the initial scan lists; these keep it there when the
 * workspace changes behind the watcher's back.
 */

/** The cached files the workspace no longer lists: gone while VS Code was away, or never in scope. */
export function filesGone(cached: readonly string[], listed: ReadonlySet<string>): string[] {
    return cached.filter((uri) => !listed.has(uri));
}

/**
 * The cached files inside `folder`: a deleted folder reaches the watcher as one
 * event for the folder, none for the files in it.
 */
export function filesUnder(cached: readonly string[], folder: string): string[] {
    const prefix = folder.endsWith('/') ? folder : `${folder}/`;
    return cached.filter((uri) => uri.startsWith(prefix));
}
