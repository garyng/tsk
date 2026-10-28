import type MarkdownIt from 'markdown-it';
import { GLYPH, MARKERS, type Marker } from './markers';
import { themeColorVar } from './theme-color';
import { isShownRef, TSK_REF } from './tsk-ref';

/**
 * `tsk:<id>` in the Markdown preview: a markdown-it plugin, given VS Code's
 * markdown-it through `extendMarkdownIt`. The refs the editor links become
 * links here too, with the task's marker after them as the editor draws it.
 * markdown-it's own linkify finds them (linkify-it's extension point for a
 * scheme), so they keep out of code and written links as other automatic
 * links do, and `markdown.preview.linkify` turns them off with the rest. Pure:
 * the tasks and the link target come from the caller.
 */

export interface PreviewTask {
    readonly marker: Marker;
    readonly text: string;
}

export interface PreviewRefs {
    /** The task with this `@id`, or undefined when no `.tsk` file has it. */
    task(id: string): PreviewTask | undefined;
    /** Where a click on the ref goes. */
    href(id: string): string;
}

const SCHEME = 'tsk:';
const UNKNOWN_COLOR_ID = 'disabledForeground';
const MARKER_STYLE = 'margin-left:0.3ch;font-family:var(--vscode-editor-font-family,monospace)';

function markerHtml(marker: Marker | undefined, escapeHtml: (s: string) => string): string {
    if (marker === undefined)
        return `<span class="tsk-ref-marker" style="${MARKER_STYLE};color:var(${themeColorVar(UNKNOWN_COLOR_ID)})">[?]</span>`;
    const color = MARKERS.find((m) => m.name === marker)?.color?.id ?? 'editor.foreground';
    return `<span class="tsk-ref-marker" data-marker="${marker}" style="${MARKER_STYLE};color:var(${themeColorVar(color)})">[${escapeHtml(GLYPH[marker])}]</span>`;
}

export function tskRefsPlugin(md: MarkdownIt, refs: PreviewRefs): void {
    // Sticky, and without linkify-it's `i`: `TSK:` isn't a ref in the editor either.
    const at = new RegExp(TSK_REF.source, 'y');
    md.linkify.add(SCHEME, {
        validate(text, pos) {
            at.lastIndex = pos - SCHEME.length;
            const id = at.exec(text)?.[1];
            return id !== undefined && isShownRef(id, refs.task(id)?.marker) ? id.length : 0;
        },
        normalize(match) {
            match.url = refs.href(match.raw.slice(SCHEME.length));
        },
    });

    const whole = new RegExp(`^${TSK_REF.source}$`);
    md.core.ruler.after('linkify', 'tsk_ref', (state) => {
        for (const block of state.tokens) {
            const tokens = block.children;
            if (block.type !== 'inline' || !tokens) continue;
            // linkify makes link_open, text, link_close; backwards, so a marker put in moves nothing still to look at.
            for (let i = tokens.length - 3; i >= 0; i--) {
                const open = tokens[i];
                const text = tokens[i + 1];
                if (
                    open?.type !== 'link_open' ||
                    open.markup !== 'linkify' ||
                    text?.type !== 'text'
                )
                    continue;
                const id = whole.exec(text.content)?.[1];
                if (id === undefined) continue;
                const task = refs.task(id);
                open.attrSet('title', task?.text ?? `No task tsk:${id} in the workspace`);
                const mark = new state.Token('html_inline', '', 0);
                mark.content = markerHtml(task?.marker, md.utils.escapeHtml);
                tokens.splice(i + 3, 0, mark);
            }
        }
        return true;
    });
}
