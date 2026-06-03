import * as vscode from 'vscode';
import { NOW_HIGHLIGHT_COLOR_ID } from './constants';
import { isTskDocument } from './editor-guards';
import type { CacheService } from './lib/cache';
import type { NowStore } from './lib/now-store';
import { parseLine } from './lib/parser';
import { pointRange } from './range-helpers';

interface NowTarget {
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
    private current: NowTarget | undefined;

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
        const target = id ? this.resolveTarget(id) : undefined;
        let painted: NowTarget | undefined;
        for (const editor of vscode.window.visibleTextEditors) {
            if (!isTskDocument(editor.document)) continue;
            if (target && editor.document.uri.toString() === target.uri) {
                editor.setDecorations(this.decorationType, [pointRange(target.line)]);
                painted = target;
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
    getCurrent(): NowTarget | undefined {
        return this.current;
    }

    dispose(): void {
        this.decorationType.dispose();
        for (const sub of this.subscriptions) sub.dispose();
    }

    /**
     * Canonical `(uri, line)` for the now-`@id`: the cache's record when present
     * (the canonical occurrence, matching the jump target); otherwise a live scan
     * of visible editors for a task carrying that `@id` (covers a just-marked or
     * untitled task the cache hasn't indexed yet).
     */
    private resolveTarget(id: string): NowTarget | undefined {
        const record = this.cache.lookupById(id);
        if (record) return { uri: record.fileUri, line: record.line };
        return this.scanVisibleForId(id);
    }

    private scanVisibleForId(id: string): NowTarget | undefined {
        for (const editor of vscode.window.visibleTextEditors) {
            const doc = editor.document;
            if (!isTskDocument(doc)) continue;
            for (let line = 0; line < doc.lineCount; line++) {
                if (parseLine(doc.lineAt(line).text)?.metadata.get('id') === id) {
                    return { uri: doc.uri.toString(), line };
                }
            }
        }
        return undefined;
    }
}
