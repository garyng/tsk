import type { TaskRecord } from './db';

/**
 * One row in the picker's "Browse tasks…" QuickPick. Carries the underlying
 * task id alongside the visible fields so the caller can resolve a
 * selection to a usable value without re-querying the cache.
 */
export interface TaskPickItem {
    label: string;
    description: string;
    detail: string;
    /** The task's `@id`. This is the value the picker returns. */
    id: string;
}

/**
 * Sanitize raw clipboard text into a candidate task id for the InputBox
 * prefill. Trims outer whitespace; takes the first whitespace-delimited
 * token so accidentally copying "id123 lorem ipsum" still surfaces a
 * usable prefill. Empty / whitespace-only input returns `''`, which the
 * caller renders as an empty InputBox.
 */
export function sanitizeClipboardForId(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed === '') return '';
    const firstToken = trimmed.split(/\s+/)[0];
    return firstToken ?? '';
}

/**
 * Convert a `TaskRecord` into a QuickPick row. `(no content)` fallback
 * keeps blank-content tasks from rendering as an empty label. `detail`
 * follows VSCode's `file:line` convention (1-indexed line for human
 * legibility).
 */
export function taskToPickItem(task: TaskRecord): TaskPickItem {
    return {
        label: task.content.trim() === '' ? '(no content)' : task.content,
        description: task.id,
        detail: `${task.fileUri}:${task.line + 1}`,
        id: task.id,
    };
}

/** What `Alt+D` does on a task that already waits on something. */
export type DependsOnChoice =
    | { readonly kind: 'add' }
    | { readonly kind: 'remove'; readonly id: string }
    | { readonly kind: 'removeAll' };

export interface DependsOnMenuItem {
    label: string;
    description?: string;
    choice: DependsOnChoice;
}

/**
 * The menu `Alt+D` opens when the task already has dependencies: add another,
 * remove one (each named by its text when the workspace knows it), or — with
 * more than one — remove them all. Pure, so the menu's shape is unit-tested;
 * `contentOf` is the cache lookup.
 */
export function dependsOnMenu(
    ids: readonly string[],
    contentOf: (id: string) => string | undefined,
): DependsOnMenuItem[] {
    const items: DependsOnMenuItem[] = [
        { label: '$(add) Add another dependency…', choice: { kind: 'add' } },
    ];
    for (const id of ids) {
        const content = contentOf(id);
        items.push({
            label: `$(close) Remove ${id}`,
            description: content === undefined ? '(missing)' : content || '(no content)',
            choice: { kind: 'remove', id },
        });
    }
    if (ids.length > 1) {
        items.push({ label: '$(trash) Remove all dependencies', choice: { kind: 'removeAll' } });
    }
    return items;
}
