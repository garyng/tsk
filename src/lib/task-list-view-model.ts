import { MARKERS, type Marker } from './markers';
import { countTasksByMarker } from './markers-find-logic';
import type { TaskCount, TaskListView, TaskRow } from './task-list-protocol';

/** Display basename of a file URI — last path segment, percent-decoded. */
export function basename(fileUri: string): string {
    const last = fileUri.split('/').pop() || fileUri;
    try {
        return decodeURIComponent(last);
    } catch {
        return last;
    }
}

/** The active `.tsk` file the "Current file" filter targets: canonical URI + display basename. */
export interface ActiveFile {
    uri: string;
    name: string;
}

/**
 * Last-`.tsk`-wins active-file tracking for the "Current file" filter. Given the
 * previously-tracked file and the newly-active editor (`undefined` when focus
 * left all editors), return the file to track: a `.tsk` document becomes the new
 * target; anything else — a non-tsk file, or the task-list panel itself stealing
 * focus — leaves the prior target in place, so the filter stays stable while you
 * work in the panel. Pure; the glue adapts a `vscode.TextDocument` to `candidate`.
 */
export function pickActiveFile(
    prev: ActiveFile | undefined,
    candidate: { uri: string; isTsk: boolean } | undefined,
): ActiveFile | undefined {
    if (!candidate || !candidate.isTsk) return prev;
    return { uri: candidate.uri, name: basename(candidate.uri) };
}

/** Metadata keys (stored bare — the `@` is display syntax). */
const CREATED_KEY = 'created';
const PRIORITY_KEY = 'priority';

/**
 * Build the {@link TaskListView}: a flat row per cached task (in `listAllTasks`
 * order — file then line), per-status counts for the filter chips (every marker,
 * registry order, even at 0), and the total. Each row is joined to its `#tags`
 * (sorted), `@created` stamp, and `@priority` level from the bulk side-tables. Pure — fed
 * `cache.listAllTasks()` / `listAllTaskTags()` / `listAllMetadata()`. Filtering,
 * sorting, and search are the webview's job, so the host ships the whole list once.
 */
export function buildTaskListView(
    tasks: Iterable<{
        id: string;
        marker: Marker;
        content: string;
        fileUri: string;
        line: number;
    }>,
    taskTags: Iterable<readonly [taskId: string, tag: string]>,
    metadata: Iterable<{ taskId: string; key: string; value: string | null }>,
): TaskListView {
    const list = [...tasks];

    // Group #tags per task (sorted for stable display), and pluck each task's
    // @created stamp — both keyed by task id, joined onto the rows below.
    const tagsByTask = new Map<string, string[]>();
    for (const [taskId, tag] of taskTags) {
        const tags = tagsByTask.get(taskId);
        if (tags) tags.push(tag);
        else tagsByTask.set(taskId, [tag]);
    }
    for (const tags of tagsByTask.values()) tags.sort();

    const createdByTask = new Map<string, string>();
    const priorityByTask = new Map<string, number>();
    for (const { taskId, key, value } of metadata) {
        if (value == null) continue;
        if (key === CREATED_KEY) createdByTask.set(taskId, value);
        else if (key === PRIORITY_KEY) {
            const level = Number(value);
            if (level === 1 || level === 2 || level === 3) priorityByTask.set(taskId, level);
        }
    }

    const rows: TaskRow[] = list.map((t) => ({
        id: t.id,
        marker: t.marker,
        content: t.content,
        file: basename(t.fileUri),
        fileUri: t.fileUri,
        line: t.line,
        tags: tagsByTask.get(t.id) ?? [],
        created: createdByTask.get(t.id),
        priority: priorityByTask.get(t.id),
    }));
    const byMarker = countTasksByMarker(list);
    const counts: TaskCount[] = MARKERS.map((def) => ({
        marker: def.name,
        label: def.label,
        count: byMarker.get(def.name) ?? 0,
    }));
    return { rows, counts, total: list.length };
}
