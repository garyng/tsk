import * as vscode from 'vscode';
import { NOW_HIGHLIGHT_COLOR_ID } from './constants';
import { isTskDocument } from './editor-guards';
import type { CacheService } from './lib/cache';
import type { NowStore } from './lib/now-store';
import { resolveNowTarget } from './now-resolve';
import { pointRange } from './range-helpers';

/** What's actually painted: the now-task's editor uri (as a string) + line. */
interface PaintedNow {
    uri: string;
    line: number;
}

/**
 * The PERSISTENT whole-line highlight on the current "now" task. Copies
 * {@link NavigationHighlight}'s shape (one `isWholeLine` decoration over a
 * `ThemeColor`) but deliberately DROPS its auto-clear — the now-mark must stay
 * put across cursor moves and tab switches, so instead of clearing on those
 * events it *re-resolves* and re-paints.
 *
 * `reapply()` resolves the current-now `@id` to its canonical `(uri, line)` via
 * `cache.lookupById` (so it matches the jump target), falling back to a live
 * scan of visible editors when the cache can't resolve it yet (a just-marked or
 * untitled task). It paints that line in the matching visible editor and clears
 * the decoration everywhere else; a now-task whose file isn't visible shows no
 * in-editor highlight (an API limit — the tree/panel is the persistent indicator
 * there).
 *
 * Self-wires to: `nowStore.onDidChange` (fires synchronously inside `markNow`,
 * so the mark lands the highlight the same tick), active/visible editor changes,
 * and document saves. Cache rescans + rebuilds re-paint via the rescan-tail hook
 * (`ScanController`), which catches external/line-shift edits the editor events
 * miss.
 */
export class NowDecoration implements vscode.Disposable {
    private readonly decorationType: vscode.TextEditorDecorationType;
    private readonly subscriptions: vscode.Disposable[] = [];
    private current: PaintedNow | undefined;

    constructor(
        private readonly cache: CacheService,
        private readonly nowStore: NowStore,
    ) {
        this.decorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor(NOW_HIGHLIGHT_COLOR_ID),
            isWholeLine: true,
        });
        this.subscriptions.push(
            this.nowStore.onDidChange(() => this.reapply()),
            vscode.window.onDidChangeActiveTextEditor(() => this.reapply()),
            vscode.window.onDidChangeVisibleTextEditors(() => this.reapply()),
            vscode.workspace.onDidSaveTextDocument(() => this.reapply()),
        );
    }

    /**
     * Re-resolve the current-now task and paint its line in the matching visible
     * editor, clearing the decoration in every other visible `.tsk` editor.
     */
    reapply(): void {
        const id = this.nowStore.getCurrentNowId();
        const target = id ? resolveNowTarget(this.cache, id) : undefined;
        const targetUri = target?.uri.toString();
        let painted: PaintedNow | undefined;
        for (const editor of vscode.window.visibleTextEditors) {
            if (!isTskDocument(editor.document)) continue;
            if (target && editor.document.uri.toString() === targetUri) {
                editor.setDecorations(this.decorationType, [pointRange(target.line)]);
                painted = { uri: targetUri as string, line: target.line };
            } else {
                editor.setDecorations(this.decorationType, []);
            }
        }
        this.current = painted;
    }

    /**
     * Snapshot of what's actually painted — `undefined` when nothing is current
     * or the now-task's file isn't visible. Exposed via `TskExtensionApi` for
     * e2e introspection (VSCode doesn't expose decoration state directly).
     */
    getCurrent(): PaintedNow | undefined {
        return this.current;
    }

    dispose(): void {
        this.decorationType.dispose();
        for (const sub of this.subscriptions) sub.dispose();
    }
}
