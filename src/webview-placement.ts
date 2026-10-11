import * as vscode from 'vscode';

import { type PanelDirection, panelPlacement } from './lib/panel-placement';

/**
 * Create one of tsk's webview panels where its own
 * `tsk.panel.<panel>.openDirection` setting says.
 *
 * Shared by the panels (Now Stack, Stats, Task List) so the placement rule has
 * one home, while each passes its own setting key and default — the defaults
 * differ because the panels' original placements differed. Re-opening an
 * already-open panel calls `reveal()` with no column, which shows it where it
 * is. The pure direction→plan mapping lives in
 * `lib/panel-placement.ts`; this is the thin adapter that owns the `vscode`
 * calls.
 *
 * **Create only, never reveal.** Re-applying a direction when an already-open
 * panel is revealed would yank a panel the user has since dragged somewhere
 * else, so `reveal()` stays untouched in every caller.
 */
export async function createPlacedPanel(
    viewType: string,
    title: string,
    options: vscode.WebviewPanelOptions & vscode.WebviewOptions,
    /** The panel's own `tsk.panel.<name>.openDirection` sub-key. */
    directionKey: string,
    /** That setting's default — the placement this panel had before the setting existed. */
    fallback: PanelDirection,
): Promise<vscode.WebviewPanel> {
    const direction = vscode.workspace.getConfiguration('tsk').get<string>(directionKey, fallback);
    const placement = panelPlacement(direction);

    const panel = vscode.window.createWebviewPanel(
        viewType,
        title,
        placement.column === 'beside' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
        options,
    );

    if (placement.moveCommand !== undefined) {
        // The move commands act on the ACTIVE editor group, which the panel
        // just became. Awaited so the panel has settled before the caller
        // starts posting to it.
        await vscode.commands.executeCommand(placement.moveCommand);
    }
    return panel;
}
