import { MARKERS, type Marker } from './markers';
import type { SearchEditorArgs } from './tags-find-logic';

/**
 * QuickPick row for the find-all-tasks-by-status picker. Structurally a
 * `vscode.QuickPickItem` (so the activation layer hands it straight to
 * `showQuickPick`) plus the canonical `marker` name the search is built from —
 * `showQuickPick` returns the same object, so the handler reads `picked.marker`.
 * vscode-free so it unit-tests without a host.
 */
export interface MarkerPickItem {
    /** Human label, e.g. "In progress". */
    label: string;
    /** Right-aligned detail: the glyph + task count, e.g. "[/]  ·  3 tasks". */
    description: string;
    /** Canonical marker name (the value `buildMarkerSearchArgs` consumes). */
    marker: Marker;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `1 task` / `0 tasks` / `12 tasks`. */
function pluraliseTaskCount(n: number): string {
    return `${n} task${n === 1 ? '' : 's'}`;
}

/**
 * Count tasks per marker. Flat — markers have no hierarchy (unlike tags, which
 * count prefix-inclusively), so this is a plain tally over the cached tasks.
 * Pure — fed `cache.listAllTasks()` (each carries its `marker`) by the caller.
 */
export function countTasksByMarker(tasks: Iterable<{ marker: Marker }>): Map<Marker, number> {
    const counts = new Map<Marker, number>();
    for (const { marker } of tasks) counts.set(marker, (counts.get(marker) ?? 0) + 1);
    return counts;
}

/** A marker's tasks, for the task-list webview. Generic so callers keep their row shape. */
export interface MarkerGroup<T> {
    marker: Marker;
    /** Human label from {@link MARKERS}, e.g. "In progress". */
    label: string;
    tasks: T[];
}

/**
 * Group tasks by marker in canonical {@link MARKERS} order, preserving each
 * task's shape (`T`). Every marker gets a group — even empty — mirroring
 * {@link markersToPickItems}, so the task-list webview can render a stable
 * section / filter chip per status. Pure — fed `cache.listAllTasks()`.
 */
export function groupTasksByMarker<T extends { marker: Marker }>(
    tasks: Iterable<T>,
): MarkerGroup<T>[] {
    const byMarker = new Map<Marker, T[]>();
    for (const def of MARKERS) byMarker.set(def.name, []);
    for (const task of tasks) byMarker.get(task.marker)?.push(task);
    return MARKERS.map((def) => ({
        marker: def.name,
        label: def.label,
        tasks: byMarker.get(def.name) ?? [],
    }));
}

/**
 * Project the canonical {@link MARKERS} into QuickPick rows — one per marker, in
 * registry order, each showing its `[glyph]` and current task count. Every marker is
 * always listed (even at `0 tasks`) since the set is small and fixed.
 */
export function markersToPickItems(counts: ReadonlyMap<Marker, number>): MarkerPickItem[] {
    return MARKERS.map((def) => ({
        label: def.label,
        description: `[${def.symbols[0]}]  ·  ${pluraliseTaskCount(counts.get(def.name) ?? 0)}`,
        marker: def.name,
    }));
}

/**
 * Build Search-Editor args matching every task line carrying `marker`. The query
 * is a REGEX anchored at line start — optional indent, a list bullet, then the
 * `[glyph]` triplet: `^\s*[-*+] \[<glyph>\]`. Anchoring is what keeps the noisy
 * `[ ]` (todo) glyph from matching arbitrary empty brackets elsewhere in a line.
 * The glyph is regex-escaped (today's marker glyphs are all metachar-free, but
 * be defensive). Mirrors {@link buildSearchEditorArgs} (the tag-search args) bar
 * `isRegexp: true`.
 */
export function buildMarkerSearchArgs(marker: Marker): SearchEditorArgs {
    const def = MARKERS.find((m) => m.name === marker);
    const glyph = escapeRegExp(def ? def.symbols[0] : ' ');
    return {
        query: `^\\s*[-*+] \\[${glyph}\\]`,
        filesToInclude: '*.tsk',
        isRegexp: true,
        triggerSearch: true,
        focusResults: true,
        showIncludesExcludes: true,
        contextLines: 0,
    };
}
