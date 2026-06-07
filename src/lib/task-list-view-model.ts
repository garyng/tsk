import { MARKERS, type Marker } from './markers';
import { countTasksByMarker } from './markers-find-logic';
import type { TaskCount, TaskListView, TaskRow } from './task-list-protocol';

/** Display basename of a file URI — last path segment, percent-decoded. */
function basename(fileUri: string): string {
    const last = fileUri.split('/').pop() || fileUri;
    try {
        return decodeURIComponent(last);
    } catch {
        return last;
    }
}

/** The metadata key carrying the `@created` stamp (stored bare — the `@` is display syntax). */
const CREATED_KEY = 'created';

/**
 * Build the {@link TaskListView}: a flat row per cached task (in `listAllTasks`
 * order — file then line), per-status counts for the filter chips (every marker,
 * registry order, even at 0), and the total. Each row is joined to its `#tags`
 * (sorted) and `@created` stamp from the two bulk side-tables. Pure — fed
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
    for (const { taskId, key, value } of metadata) {
        if (key === CREATED_KEY && value != null) createdByTask.set(taskId, value);
    }

    const rows: TaskRow[] = list.map((t) => ({
        id: t.id,
        marker: t.marker,
        content: t.content,
        file: basename(t.fileUri),
        line: t.line,
        tags: tagsByTask.get(t.id) ?? [],
        created: createdByTask.get(t.id),
    }));
    const byMarker = countTasksByMarker(list);
    const counts: TaskCount[] = MARKERS.map((def) => ({
        marker: def.name,
        label: def.label,
        count: byMarker.get(def.name) ?? 0,
    }));
    return { rows, counts, total: list.length };
}
