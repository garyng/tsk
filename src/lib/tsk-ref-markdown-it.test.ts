import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import type { Marker } from './markers';
import { themeColorVar } from './theme-color';
import { type PreviewTask, tskRefsPlugin } from './tsk-ref-markdown-it';

const TASKS: Record<string, PreviewTask> = {
    m3task1: { marker: 'completed', text: 'Ship the <preview> & links' },
    '5tdnqp74': { marker: 'todo', text: 'tsk for Claude' },
};

function render(src: string, opts: { linkify?: boolean } = {}): string {
    const md = new MarkdownIt({ linkify: opts.linkify ?? true });
    md.linkify.set({ fuzzyLink: false }); // as VS Code's preview sets it
    tskRefsPlugin(md, {
        task: (id) => TASKS[id],
        href: (id) => `vscode://garyng.tsk/open?id=${id}`,
    });
    return md.renderInline(src);
}

const marker = (name: Marker, glyph: string) =>
    `<span class="tsk-ref-marker" data-marker="${name}" style="margin-left:0.3ch;font-family:var(--vscode-editor-font-family,monospace);color:var(${themeColorVar(`tsk.marker.${name}`)})">[${glyph}]</span>`;

describe('tskRefsPlugin', () => {
    it('links a known id to its URI, the task’s text as the tooltip, its marker after it', () => {
        expect(render('see tsk:m3task1.')).toBe(
            `see <a href="vscode://garyng.tsk/open?id=m3task1" title="Ship the &lt;preview&gt; &amp; links">tsk:m3task1</a>${marker('completed', 'x')}.`,
        );
    });

    it('keeps the width of a todo’s marker', () => {
        expect(render('tsk:5tdnqp74')).toContain(marker('todo', ' '));
    });

    it('links an unknown id that looks generated, with a muted [?]', () => {
        expect(render('tsk:zzzzzzzz')).toBe(
            '<a href="vscode://garyng.tsk/open?id=zzzzzzzz" title="No task tsk:zzzzzzzz in the workspace">tsk:zzzzzzzz</a><span class="tsk-ref-marker" style="margin-left:0.3ch;font-family:var(--vscode-editor-font-family,monospace);color:var(--vscode-disabledForeground)">[?]</span>',
        );
    });

    it('leaves prose alone: an unknown id that doesn’t look generated, tsk: mid-word, in capitals', () => {
        for (const src of ['run task tsk:test', 'notsk:m3task1', 'TSK:m3task1'])
            expect(render(src), src).toBe(new MarkdownIt().renderInline(src));
    });

    it('takes the whole id, as the editor does', () => {
        expect(render('tsk:m3task1x')).toBe('tsk:m3task1x');
    });

    it('links each of several refs on a line', () => {
        const html = render('tsk:m3task1 then (tsk:5tdnqp74)');
        expect(html.match(/<a /g)).toHaveLength(2);
        expect(html).toContain('(<a href="vscode://garyng.tsk/open?id=5tdnqp74"');
    });

    it('leaves code spans, code blocks and written links alone', () => {
        expect(render('`tsk:m3task1`')).toBe('<code>tsk:m3task1</code>');
        expect(render('[tsk:m3task1](plans/x.md)')).toBe('<a href="plans/x.md">tsk:m3task1</a>');
        const md = new MarkdownIt({ linkify: true });
        tskRefsPlugin(md, { task: (id) => TASKS[id], href: (id) => id });
        expect(md.render('```\ntsk:m3task1\n```\n')).not.toContain('<a');
    });

    it('works in a list item and a heading', () => {
        const md = new MarkdownIt({ linkify: true });
        tskRefsPlugin(md, { task: (id) => TASKS[id], href: (id) => `u:${id}` });
        const html = md.render('# Phase tsk:5tdnqp74\n\n- tsk:m3task1 **done**\n');
        expect(html).toContain('<h1>Phase <a href="u:5tdnqp74"');
        expect(html).toContain('<li><a href="u:m3task1"');
    });

    it('is off with the preview’s other automatic links', () => {
        expect(render('tsk:m3task1', { linkify: false })).toBe('tsk:m3task1');
    });
});
