import type { TagDef } from './tags-config';

/**
 * Shape of a QuickPick row for the find-all-tasks-by-tag picker.
 * Structurally compatible with `vscode.QuickPickItem` so the activation
 * layer can hand the result straight to `showQuickPick` — no further
 * wrapping needed. Kept vscode-free so the helper is unit-testable
 * without a host.
 */
export interface TagPickItem {
    /** Tag name as it appears in `.tsk` files (no leading `#`). */
    label: string;
    /** `tags.yml` description, omitted entirely when none is set. */
    description?: string;
}

/**
 * Project a merged tag map (`yamlDefs` ∪ expanded-discovered) into
 * QuickPick rows. Iteration order matches the input map — yaml entries
 * first (in document order), then implicit-parent / discovered-only
 * tags. The QuickPick consumer enables `matchOnDescription: true`, so
 * users can search by either the tag name or the yaml description.
 */
export function tagsToPickItems(merged: ReadonlyMap<string, TagDef>): TagPickItem[] {
    const items: TagPickItem[] = [];
    for (const [name, def] of merged) {
        const item: TagPickItem = { label: name };
        if (def.description) item.description = def.description;
        items.push(item);
    }
    return items;
}

/**
 * Args passed verbatim to `workbench.action.findInFiles`. We always:
 * - prefix the query with `#` so the search finds the tag token itself
 *   (substring-match against the rest of the file content);
 * - scope to `*.tsk` so the result list is on-topic;
 * - trigger immediately so the user lands inside the populated Search
 *   panel rather than an empty search bar they'd have to confirm.
 *
 * Substring semantics (intended): searching for `#project` will also
 * surface `#project/tsk` lines, which we read as a feature — finding
 * tasks under a parent tag naturally includes its children. If the user
 * needs an exact match, the Search bar's regex toggle is one click
 * away (`^|\s#project($|\s)` or similar).
 */
export interface FindInFilesArgs {
    query: string;
    filesToInclude: string;
    triggerSearch: boolean;
}

export function buildFindInFilesArgs(tagName: string): FindInFilesArgs {
    return {
        query: `#${tagName}`,
        filesToInclude: '*.tsk',
        triggerSearch: true,
    };
}
