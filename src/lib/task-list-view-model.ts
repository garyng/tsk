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

/**
 * Build the {@link TaskListView}: a flat row per cached task (in `listAllTasks`
 * order — file then line), per-status counts for the filter chips (every marker,
 * registry order, even at 0), and the total. Pure — fed `cache.listAllTasks()`.
 * Filtering is the webview's job, so the host ships the whole list once.
 */
export function buildTaskListView(
    tasks: Iterable<{
        id: string;
        marker: Marker;
        content: string;
        fileUri: string;
        line: number;
    }>,
): TaskListView {
    const list = [...tasks];
    const rows: TaskRow[] = list.map((t) => ({
        id: t.id,
        marker: t.marker,
        content: t.content,
        file: basename(t.fileUri),
        line: t.line,
    }));
    const byMarker = countTasksByMarker(list);
    const counts: TaskCount[] = MARKERS.map((def) => ({
        marker: def.name,
        label: def.label,
        count: byMarker.get(def.name) ?? 0,
    }));
    return { rows, counts, total: list.length };
}
