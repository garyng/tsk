import { posix } from 'node:path';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { DetailLine, DetailSpan } from '../lib/markdown-lines';
import type { Marker } from '../lib/markers';
import { detailWindow } from '../lib/tui-detail';
import type { Style, Theme } from './theme';

/**
 * The detail pane: a rule, the selected task's facts, a rule naming its
 * plan's file and the line in view, then the file rendered from `top`. All
 * the layout is `tui-detail.ts` and `markdown-lines.ts`; this only draws.
 */

/** The linked file as loaded: its text, or why it couldn't be read. */
export interface DetailDoc {
    /** The link as written, `[[path]]`. */
    readonly path: string;
    /** Where it resolved. */
    readonly file?: string;
    readonly text?: string;
    readonly error?: string;
}

export function DetailPane({
    theme,
    width,
    rows,
    marker,
    facts,
    doc,
    lines,
    top,
    border,
}: {
    theme: Theme;
    width: number;
    rows: number;
    /** The selected task's state, for the facts' glyph; undefined when nothing is selected. */
    marker: Marker | undefined;
    facts: readonly DetailLine[];
    doc: DetailDoc | undefined;
    /** The file's rendered lines. */
    lines: readonly DetailLine[];
    top: number;
    /** A left border, when the pane sits beside the list. */
    border: boolean;
}) {
    const inner = border ? width - 1 : width;
    const win = detailWindow(rows, facts.length, lines.length, top);
    const shown = lines.slice(win.top, win.top + win.fileRows);
    const fileRule = (): DetailSpan[] => {
        if (!marker) return [{ text: 'nothing selected', tone: 'muted' }];
        if (!doc) return [{ text: 'no plan linked: tsk link <id> <path>', tone: 'muted' }];
        if (doc.error) return [{ text: `couldn't read ${doc.path}: ${doc.error}`, tone: 'error' }];
        const at = shown.find((l) => l.source !== undefined)?.source;
        const name = `── ${posix.basename(doc.path)}${at !== undefined ? `:${at + 1}` : ''} `;
        return [{ text: name + '─'.repeat(Math.max(0, inner - stringWidth(name))), tone: 'rule' }];
    };
    const styleOf = (s: DetailSpan): Style =>
        s.tone === 'marker' && marker ? theme.glyph[marker] : theme.detail[s.tone];
    return (
        <Box
            flexDirection="column"
            width={width}
            height={rows}
            overflow="hidden"
            borderStyle={border ? 'single' : undefined}
            borderTop={false}
            borderBottom={false}
            borderRight={false}
            borderColor={theme.rule.color}
            borderDimColor={!theme.color}
        >
            <Text {...theme.rule}>{'━'.repeat(Math.max(1, inner))}</Text>
            {facts.slice(0, win.facts).map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the facts are redrawn whole; a line's place is its identity.
                <Row key={i} line={l} styleOf={styleOf} />
            ))}
            <Row line={{ spans: fileRule() }} styleOf={styleOf} />
            {shown.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: as above, a window over the file's lines.
                <Row key={win.top + i} line={l} styleOf={styleOf} />
            ))}
        </Box>
    );
}

function Row({ line, styleOf }: { line: DetailLine; styleOf: (s: DetailSpan) => Style }) {
    let at = 0;
    return (
        <Text wrap="truncate-end">
            {line.spans.length === 0
                ? ' '
                : line.spans.map((s) => {
                      const key = at;
                      at += s.text.length;
                      return (
                          <Text key={key} {...styleOf(s)}>
                              {s.text}
                          </Text>
                      );
                  })}
        </Text>
    );
}
