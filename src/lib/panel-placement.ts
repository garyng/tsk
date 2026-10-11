/**
 * Where tsk's webview panels (Now Stack, Stats, Task List) open — the pure
 * half of the per-panel `tsk.panel.<panel>.openDirection` settings.
 *
 * **Why this isn't just a `ViewColumn`:** `ViewColumn` is horizontal only
 * (`One`, `Two`, …, `Beside`, `Active`) — there is no `ViewColumn.Below`. Up
 * and down have to be reached by creating the panel and then running one of
 * VS Code's own group commands, which is why a direction maps to a column
 * PLUS an optional follow-up command rather than to a column alone.
 */

/** The values each `tsk.panel.<panel>.openDirection` setting accepts. */
export type PanelDirection = 'right' | 'left' | 'above' | 'below' | 'active';

/** Which `ViewColumn` to create in — spelled without importing `vscode`. */
export type PanelColumn = 'beside' | 'active';

export interface PanelPlacement {
    column: PanelColumn;
    /** A `workbench.action.*` command to run once the panel is the active editor. */
    moveCommand?: string;
}

/**
 * Resolve a direction into a create-then-move plan.
 *
 * `left` / `above` / `below` create in the **active** column, not beside it.
 * The move commands act relative to the active group — into an existing
 * neighbour in that direction, or a new split when there is none — so starting
 * in the editor's own group places the panel relative to the file. Starting
 * beside it would place it relative to the new right-hand group instead, and
 * `left` would land straight back in the editor's own group.
 *
 * An unrecognised value falls back to `right` rather than throwing — same
 * forgiveness as the tags and autolinks settings parsers, since a settings
 * typo should not stop a panel from opening.
 */
export function panelPlacement(direction: string): PanelPlacement {
    switch (direction) {
        case 'active':
            return { column: 'active' };
        case 'left':
            return { column: 'active', moveCommand: 'workbench.action.moveEditorToLeftGroup' };
        case 'above':
            return { column: 'active', moveCommand: 'workbench.action.moveEditorToAboveGroup' };
        case 'below':
            return { column: 'active', moveCommand: 'workbench.action.moveEditorToBelowGroup' };
        default:
            return { column: 'beside' };
    }
}

/**
 * Keep a panel's remembered "source" editor group off the panel itself.
 *
 * The Now and Task List panels remember which group to jump back into, and
 * capture it when they are constructed — BEFORE the panel exists. An `above` /
 * `left` placement then renumbers the groups, so the remembered column can end
 * up naming the panel's own group: a jump to a file that is not currently
 * visible would open it over the panel. (`navigateTo`'s `reuseVisible` covers
 * the case where the file IS visible somewhere.) The stale value self-heals on
 * the next editor focus via `onDidChangeActiveTextEditor`; this closes the
 * window before that happens.
 *
 * Returns `current` when it is already safe, else the first visible column
 * that is not the panel's, else `1`.
 */
export function reviseSourceColumn(
    current: number,
    panelColumn: number | undefined,
    visibleColumns: readonly number[],
): number {
    if (panelColumn === undefined || current !== panelColumn) return current;
    return visibleColumns.find((column) => column !== panelColumn) ?? 1;
}
