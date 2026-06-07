import { expandImplicitParents, type TagDef } from './tags-config';

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
    /**
     * Right-aligned QuickPick detail. Always carries the task count
     * (`"N tasks"`); appends the yaml description after a `·` separator
     * when one exists. Always set (count is never omitted), so the
     * field is non-optional unlike the pre-M21 version.
     */
    description: string;
}

/**
 * Count the number of distinct tasks associated with each tag, where
 * "associated" follows the **hierarchical** rule: a task tagged
 * `#project/tsk` counts toward both `project/tsk` AND its implicit
 * parent `project` (via {@link expandImplicitParents}).
 *
 * **Why prefix-inclusive, not exact `GROUP BY tag`.** The picker lists
 * implicit-parent tags (e.g. `project`) that no task carries *literally*.
 * An exact count would render those as `0 tasks` even though picking
 * them runs a `#project` substring search that DOES return the
 * `#project/tsk` lines. Prefix-inclusive counts keep the picker's number
 * consistent with what the search actually surfaces, and match the
 * hierarchy semantics the rest of the tag system already uses. A task
 * tagged with both `#project` and `#project/tsk` is still counted once
 * per tag (Set-deduped by task id).
 *
 * Pure — fed the flat `(taskId, tag)` pairs by the cache layer so it can
 * be unit-tested without a DB.
 */
export function countTasksByTag(
    taskTags: Iterable<readonly [taskId: string, tag: string]>,
): Map<string, number> {
    const tagsByTask = new Map<string, string[]>();
    for (const [taskId, tag] of taskTags) {
        const list = tagsByTask.get(taskId);
        if (list) list.push(tag);
        else tagsByTask.set(taskId, [tag]);
    }

    const taskIdsByTag = new Map<string, Set<string>>();
    for (const [taskId, tags] of tagsByTask) {
        for (const expanded of expandImplicitParents(tags)) {
            let set = taskIdsByTag.get(expanded);
            if (!set) {
                set = new Set<string>();
                taskIdsByTag.set(expanded, set);
            }
            set.add(taskId);
        }
    }

    const counts = new Map<string, number>();
    for (const [tag, ids] of taskIdsByTag) counts.set(tag, ids.size);
    return counts;
}

/** `1 task` / `0 tasks` / `12 tasks` — pluralised count label. */
function pluraliseTaskCount(n: number): string {
    return `${n} task${n === 1 ? '' : 's'}`;
}

/**
 * Project a merged tag map (`yamlDefs` ∪ expanded-discovered) into
 * QuickPick rows. Iteration order matches the input map — yaml entries
 * first (in document order), then implicit-parent / discovered-only
 * tags. The QuickPick consumer enables `matchOnDescription: true`, so
 * users can search by either the tag name or the row description.
 *
 * Each row's `description` is `"<count> tasks"`, optionally followed by
 * `" · <yaml description>"`. A tag declared in `tags.yml` but carried by
 * no task renders as `"0 tasks · <desc>"` — kept in the list (not
 * dropped) so the user sees that the tag exists but is currently empty.
 */
export function tagsToPickItems(
    merged: ReadonlyMap<string, TagDef>,
    counts: ReadonlyMap<string, number>,
): TagPickItem[] {
    const items: TagPickItem[] = [];
    for (const [name, def] of merged) {
        const count = counts.get(name) ?? 0;
        const countLabel = pluraliseTaskCount(count);
        const description = def.description ? `${countLabel} · ${def.description}` : countLabel;
        items.push({ label: name, description });
    }
    return items;
}

/**
 * Args passed verbatim to the `search.action.openNewEditor` command
 * (VS Code's **Search Editor** — a full-tab result document, not the
 * side panel). Subset of `OpenSearchEditorArgs`; the fields we set:
 *
 * - `query` — prefixed with `#` so the search finds the tag token itself
 *   (substring-match against file content).
 * - `filesToInclude: '*.tsk'` — scope the result list to task files.
 * - `isRegexp: false` — plain substring, explicit (don't inherit the
 *   user's last regex-toggle state from a prior search).
 * - `triggerSearch: true` — run immediately so the editor opens already
 *   populated rather than waiting on the user to confirm.
 * - `focusResults: true` — land the cursor in the results so click-to-jump
 *   / arrow-navigation works without a manual focus shift.
 * - `showIncludesExcludes: true` — reveal the include/exclude inputs so
 *   the `*.tsk` scope is visible (and tweakable) rather than hidden.
 * - `contextLines: 0` — show only the matching task lines, no surrounding
 *   context. A tag search wants the tasks, not their neighbours; this also
 *   overrides the user's `search.searchEditor.defaultNumberOfContextLines`
 *   (default 1) for tsk tag searches specifically.
 *
 * **Why the Search Editor over `findInFiles` (the side panel).** Search-
 * editor results render in a real editor tab that inherits click-to-jump,
 * regex/case toggles, and result folding for free, and (unlike the side panel)
 * is a `vscode.TextEditor` we can decorate. Note: the result document's
 * `search-result` grammar only embeds ~50 built-in languages, so it does NOT
 * apply tsk's *grammar* to result rows — instead the extension paints tsk
 * *decorations* onto the match rows itself (see `DecorationsController.applySearchResult`
 * / `computeSearchResultRanges`, M30/B).
 *
 * Substring semantics (intended): searching `#project` also surfaces
 * `#project/tsk` lines — finding tasks under a parent tag naturally
 * includes its children, mirroring the hierarchical count in the picker.
 * For an exact match the editor's regex toggle is one click away
 * (`(^|\s)#project($|\s)`).
 */
export interface SearchEditorArgs {
    query: string;
    filesToInclude: string;
    isRegexp: boolean;
    triggerSearch: boolean;
    focusResults: boolean;
    showIncludesExcludes: boolean;
    contextLines: number;
}

export function buildSearchEditorArgs(tagName: string): SearchEditorArgs {
    return {
        query: `#${tagName}`,
        filesToInclude: '*.tsk',
        isRegexp: false,
        triggerSearch: true,
        focusResults: true,
        showIncludesExcludes: true,
        contextLines: 0,
    };
}
