import { formatDistance } from 'date-fns';
import type { TaskRecord } from './db';
import type { GraphNode } from './graph';
import type { Marker } from './markers';

/**
 * Shape of one task projected for hover rendering. Subset of `ParsedTask`
 * + the line's fileUri so links can target the right document.
 *
 * Note: we deliberately do NOT include `content` in the rendered hover —
 * the source line is already under the user's cursor, so re-printing it
 * just adds noise. The header shows the marker's status label only.
 */
export interface HoverTaskInput {
    marker: Marker;
    /** @key → value (string) or null (for `@flag` without colon). */
    metadata: ReadonlyMap<string, string | null>;
    /** Tag names without the leading `#`. */
    tags: readonly string[];
    fileUri: string;
    /** Zero-indexed line number — converted to 1-indexed in the footer. */
    line: number;
}

/**
 * Inputs the rendering helper consumes. Lookups are functions so tests
 * can pass stubs; the activation layer injects `cache.lookupById` /
 * `graph.getNode` / `tagsLoader.getTags().get(...).description` /
 * `() => new Date()`.
 */
export interface HoverDeps {
    lookupTask: (id: string) => TaskRecord | undefined;
    lookupGraph: (id: string) => GraphNode | undefined;
    lookupTagDescription: (tag: string) => string | undefined;
    /** Reference point for human-friendly relative timestamps. */
    now: () => Date;
}

/**
 * Marker → human-readable status word for the hover header. Avoids
 * re-printing the marker glyph itself (already visible in the source
 * line) while still naming the state at a glance.
 */
const MARKER_LABEL: Record<Marker, string> = {
    todo: 'Todo',
    inprogress: 'In Progress',
    completed: 'Completed',
    cancelled: 'Cancelled',
    moved: 'Moved',
    notes: 'Note',
};

/**
 * Build the markdown body for a task's hover popup. Pure — no vscode
 * import. The activation layer wraps the returned string in a
 * `vscode.MarkdownString` with `isTrusted: true` so the `command:` URIs
 * are clickable.
 *
 * Section order: header, metadata table, tags, forward refs, inverse
 * refs, footer. Sections with no content are omitted (no empty
 * "Tags: " line, no zero-row table).
 *
 * **Forward refs** to ids the workspace doesn't know are rendered as
 * `*— missing in workspace*` — redundant with the M20/B diagnostic
 * squiggle, but the hover is what users read at the point of curiosity.
 *
 * **Inverse-ref navigation** uses `tsk.goToParent` regardless of
 * relationship — the command unconditionally navigates to the passed id,
 * and the link's label (target's title) carries the meaning. Single
 * navigation primitive keeps the surface small; the command's name is an
 * implementation detail the user never sees.
 */
export function buildTaskHoverMarkdown(task: HoverTaskInput, deps: HoverDeps): string {
    const parts: string[] = [];

    // Header — status label only. Task content stays in the source line
    // under the user's cursor; re-printing it here adds noise.
    parts.push(`**${MARKER_LABEL[task.marker]}**`);

    // Metadata table.
    const id = task.metadata.get('id');
    const metaRows: Array<[string, string]> = [];
    if (typeof id === 'string' && id !== '') metaRows.push(['id', `\`${id}\``]);
    const priority = task.metadata.get('priority');
    if (typeof priority === 'string' && priority !== '') {
        metaRows.push(['priority', `P${priority}`]);
    }
    for (const key of ['created', 'started', 'completed', 'cancelled', 'moved'] as const) {
        const value = task.metadata.get(key);
        if (typeof value === 'string' && value !== '') {
            metaRows.push([key, formatTimestamp(value, deps.now())]);
        }
    }
    if (metaRows.length > 0) {
        parts.push('');
        parts.push('| | |');
        parts.push('|--|--|');
        for (const [k, v] of metaRows) parts.push(`| ${k} | ${v} |`);
    }

    // Tags.
    if (task.tags.length > 0) {
        const tagBits = task.tags.map((tag) => {
            const desc = deps.lookupTagDescription(tag);
            return desc ? `\`#${tag}\` *(${escapeMarkdown(desc)})*` : `\`#${tag}\``;
        });
        parts.push('');
        parts.push(`**Tags:** ${tagBits.join(' · ')}`);
    }

    // Forward refs.
    const forwardRefs: Array<[string, string, string]> = [];
    for (const [label, key] of [
        ['parent', 'parent'],
        ['depends on', 'dependsOn'],
        ['related to', 'relatedTo'],
    ] as const) {
        const targetId = task.metadata.get(key);
        if (typeof targetId !== 'string' || targetId === '') continue;
        forwardRefs.push([label, 'tsk.goToParent', targetId]);
    }
    for (const [label, command, targetId] of forwardRefs) {
        const target = deps.lookupTask(targetId);
        if (target) {
            const labelText = target.content === '' ? '*(empty)*' : escapeMarkdown(target.content);
            const link = commandLink(command, [targetId], labelText);
            parts.push('');
            parts.push(`**${label}:** ${link} \`(${targetId})\``);
        } else {
            parts.push('');
            parts.push(`**${label}:** \`(${targetId})\` *— missing in workspace*`);
        }
    }

    // Inverse refs (require @id + a graph node).
    if (typeof id === 'string' && id !== '') {
        const node = deps.lookupGraph(id);
        if (node) {
            for (const [label, ids] of [
                ['children', node.inverse.children],
                ['dependents', node.inverse.dependents],
                ['related', node.inverse.related],
            ] as const) {
                if (ids.length === 0) continue;
                const links = ids.map((childId) => {
                    const target = deps.lookupTask(childId);
                    const labelText =
                        target && target.content !== ''
                            ? escapeMarkdown(target.content)
                            : `\`${childId}\``;
                    return commandLink('tsk.goToParent', [childId], labelText);
                });
                parts.push('');
                parts.push(`**${label} (${ids.length}):** ${links.join(', ')}`);
            }
        }
    }

    // Footer — file path + 1-indexed line.
    parts.push('');
    parts.push(`*${task.fileUri}:${task.line + 1}*`);

    return parts.join('\n');
}

/**
 * Build a `command:<id>?<encoded-args>` URI suitable for a markdown link
 * in a trusted `MarkdownString`. Args are JSON-encoded then
 * `encodeURIComponent`-escaped so brackets/quotes don't break the URI.
 */
function commandLink(command: string, args: unknown[], label: string): string {
    const encoded = encodeURIComponent(JSON.stringify(args));
    return `[${label}](command:${command}?${encoded})`;
}

/**
 * Relative-time phrase like "3 minutes ago" (date-fns `formatDistance`, with
 * suffix). Returns the raw value unchanged if it isn't a parseable date —
 * shared by the hover timestamp and the now-stack `when` column.
 */
export function formatRelativeTime(value: string, now: Date): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return formatDistance(date, now, { addSuffix: true });
}

/**
 * Render an ISO-8601 timestamp with a parenthesised human-friendly relative
 * distance, e.g. `2026-05-27T10:00:00+08:00 (2 hours ago)`. Falls back to the
 * raw value when the string doesn't parse — we never want a broken timestamp to
 * crash the hover.
 */
function formatTimestamp(value: string, now: Date): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return `${value} (${formatRelativeTime(value, now)})`;
}

/**
 * Escape characters that would break markdown rendering inside the
 * task's content or tag descriptions. Pipe specifically would break the
 * metadata table; backticks would break inline-code spans; brackets +
 * parens would break links.
 */
function escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, (m) => `\\${m}`);
}
