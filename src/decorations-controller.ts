import * as vscode from 'vscode';
import { METADATA_FOREGROUND_COLOR_ID } from './constants';
import { isTskDocument } from './editor-guards';
import { scheduleDebounced } from './lib/debounce';
import {
    computeMarkerRanges,
    computeMetadataRanges,
    computePriorityRanges,
    priorityBackgroundColor,
    type RangeLike,
} from './lib/decorations';
import { MARKERS, type Marker } from './lib/markers';
import { parseDocument } from './lib/parser';
import { PRIORITIES, type PriorityLevel } from './lib/priorities';
import { computeSearchResultRanges } from './lib/search-result-decorations';

/**
 * Last-applied decoration ranges for a `.tsk` document, captured right after
 * `setDecorations`. Exposed (read-only) via the extension API so e2e tests can
 * assert what was rendered — VSCode doesn't surface applied decorations.
 */
export interface DecorationSnapshot {
    markers: Record<Marker, RangeLike[]>;
    priorities: Record<PriorityLevel, RangeLike[]>;
    /** Flat list of `<!-- ... -->` ranges across all tasks on this URI. */
    metadata: RangeLike[];
}

/**
 * Owns the marker / priority / metadata decoration types and applies them to
 * editors. Two render paths share one range-application helper: `.tsk` editors
 * (ranges parsed from the document) and the find-by-tag Search Editor's
 * `search-result` rows (ranges parsed from the result text, offset past the
 * gutter). A per-URI snapshot map backs the e2e introspection API; a per-URI
 * timer map debounces re-decoration on document change.
 *
 * Glue (vscode), extracted from `extension.ts` so the activation file stays
 * lifecycle + wiring. The range *computation* is pure (`lib/decorations`,
 * `lib/search-result-decorations`); only `setDecorations` and the decoration
 * types live here.
 */
export class DecorationsController {
    private markerTypes: Record<Marker, vscode.TextEditorDecorationType>;
    private priorityTypes: Record<PriorityLevel, vscode.TextEditorDecorationType>;
    private readonly metadataType: vscode.TextEditorDecorationType;
    /** Per-URI debounce timers for decoration refresh on document change. */
    private readonly timers = new Map<string, NodeJS.Timeout>();
    /** Per-URI snapshot of last-applied ranges (for the e2e API). */
    private readonly snapshots = new Map<string, DecorationSnapshot>();

    constructor(context: vscode.ExtensionContext, priorityOpacity: number) {
        this.markerTypes = buildMarkerDecorationTypes();
        for (const type of Object.values(this.markerTypes)) context.subscriptions.push(type);

        this.priorityTypes = buildPriorityDecorationTypes(priorityOpacity);
        // Priority types are rebuilt on opacity change; this disposer walks the
        // *current* set (the field is reassigned in rebuildPriority), so the
        // post-rebuild replacement is still cleaned up at deactivation.
        context.subscriptions.push({
            dispose: () => {
                for (const type of Object.values(this.priorityTypes)) type.dispose();
            },
        });

        this.metadataType = vscode.window.createTextEditorDecorationType({
            color: new vscode.ThemeColor(METADATA_FOREGROUND_COLOR_ID),
        });
        context.subscriptions.push(this.metadataType);
    }

    /** Last-applied ranges for `uri.toString()`, or `undefined` if never decorated. */
    getSnapshot(uri: string): DecorationSnapshot | undefined {
        return this.snapshots.get(uri);
    }

    /** Dispose + rebuild the priority types at a new opacity, then re-decorate. */
    rebuildPriority(opacity: number): void {
        for (const type of Object.values(this.priorityTypes)) type.dispose();
        this.priorityTypes = buildPriorityDecorationTypes(opacity);
        for (const editor of vscode.window.visibleTextEditors) this.applyToEditor(editor);
    }

    /**
     * Decorate one editor. Dispatches: a `search-result` document gets the
     * gutter-offset tag-search decorations; a `.tsk` document gets the full
     * marker / priority / metadata pass plus a stored snapshot; anything else is
     * skipped.
     */
    applyToEditor(editor: vscode.TextEditor): void {
        if (editor.document.languageId === 'search-result') {
            this.applySearchResult(editor);
            return;
        }
        if (!isTskDocument(editor.document)) return;

        const tasks = parseDocument(editor.document.getText());
        const markerRanges = computeMarkerRanges(tasks);
        const priorityRanges = computePriorityRanges(tasks);
        const metadataRanges = computeMetadataRanges(tasks);

        this.applyRangeTriple(editor, markerRanges, priorityRanges, metadataRanges);

        // Snapshot every marker / priority bucket (empty arrays included) so the
        // e2e API mirrors exactly what was set — the clears included.
        const markers = {} as Record<Marker, RangeLike[]>;
        for (const def of MARKERS) markers[def.name] = markerRanges.get(def.name) ?? [];
        const priorities = {} as Record<PriorityLevel, RangeLike[]>;
        for (const def of PRIORITIES) priorities[def.level] = priorityRanges.get(def.level) ?? [];
        this.snapshots.set(editor.document.uri.toString(), {
            markers,
            priorities,
            metadata: metadataRanges,
        });
    }

    /** Decorate every visible editor backing `doc` (split panes / multiple groups). */
    applyForDoc(doc: vscode.TextDocument): void {
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document === doc) this.applyToEditor(editor);
        }
    }

    /** Debounced `applyForDoc`, keyed per URI. */
    scheduleDecorate(doc: vscode.TextDocument, debounceMs: number): void {
        scheduleDebounced(this.timers, doc.uri.toString(), debounceMs, () => this.applyForDoc(doc));
    }

    /** Drop the URI's snapshot and cancel any pending decorate timer. */
    evict(uri: string): void {
        this.snapshots.delete(uri);
        const timer = this.timers.get(uri);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(uri);
        }
    }

    /** Cancel all pending decorate timers (deactivation). */
    clearTimers(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }

    /**
     * Apply tsk decorations to a Search Editor (`search-result`) result view —
     * the find-by-tag output. Same decoration types as `.tsk` editors, but the
     * ranges come from {@link computeSearchResultRanges}, which strips each row's
     * `␣␣<lineNo>:␣` gutter and shifts columns onto the row. No snapshot is stored:
     * `search-result` URIs are ephemeral, and the snapshot map is the `.tsk`
     * restore/GC concern.
     */
    private applySearchResult(editor: vscode.TextEditor): void {
        const { markers, priorities, metadata } = computeSearchResultRanges(
            editor.document.getText(),
        );
        this.applyRangeTriple(editor, markers, priorities, metadata);
    }

    /**
     * The shared marker / priority / metadata `setDecorations` pass. Every marker
     * and priority type is set — empty arrays included — so a bucket that lost its
     * last range gets cleared. Used by both the `.tsk` and search-result paths.
     */
    private applyRangeTriple(
        editor: vscode.TextEditor,
        markers: ReadonlyMap<Marker, RangeLike[]>,
        priorities: ReadonlyMap<PriorityLevel, RangeLike[]>,
        metadata: readonly RangeLike[],
    ): void {
        for (const def of MARKERS) {
            editor.setDecorations(
                this.markerTypes[def.name],
                (markers.get(def.name) ?? []).map(toVscodeRange),
            );
        }
        for (const def of PRIORITIES) {
            editor.setDecorations(
                this.priorityTypes[def.level],
                (priorities.get(def.level) ?? []).map(toVscodeRange),
            );
        }
        editor.setDecorations(this.metadataType, metadata.map(toVscodeRange));
    }
}

function buildMarkerDecorationTypes(): Record<Marker, vscode.TextEditorDecorationType> {
    const out = {} as Record<Marker, vscode.TextEditorDecorationType>;
    for (const def of MARKERS) {
        const options: vscode.DecorationRenderOptions = {};
        if (def.color) options.color = new vscode.ThemeColor(def.color.id);
        if (def.strikethrough) options.textDecoration = 'line-through';
        out[def.name] = vscode.window.createTextEditorDecorationType(options);
    }
    return out;
}

function buildPriorityDecorationTypes(
    opacity: number,
): Record<PriorityLevel, vscode.TextEditorDecorationType> {
    const out = {} as Record<PriorityLevel, vscode.TextEditorDecorationType>;
    for (const def of PRIORITIES) {
        out[def.level] = vscode.window.createTextEditorDecorationType({
            backgroundColor: priorityBackgroundColor(def.level, opacity),
            isWholeLine: true,
        });
    }
    return out;
}

function toVscodeRange(r: RangeLike): vscode.Range {
    return new vscode.Range(r.startLine, r.startCol, r.endLine, r.endCol);
}
