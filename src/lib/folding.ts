/**
 * Pure folding-range computation for `.tsk` files: divider sections AND
 * indentation blocks, in one pass.
 *
 * **Why indentation is in here at all** (measured 2026-10-11, not assumed):
 * registering ANY `FoldingRangeProvider` for a language makes VS Code use it
 * *instead of* the built-in indentation strategy — `editor.foldingStrategy:
 * auto` means "provider if one exists, indentation otherwise", not "both".
 * Probed with `vscode.executeFoldingRangeProvider` on a file holding a nested
 * task block and a divider:
 *
 * ```
 * no provider   → [{start:0, end:2}]              // the task block
 * divider-only  → [{start:3, end:6, kind:region}] // the block is GONE
 * ```
 *
 * So shipping divider folding without re-implementing indentation folding
 * would have silently traded away task-block folding, which is the one people
 * actually use. The e2e suite pins this ("indentation folding SURVIVES the
 * provider"), since the new feature would look fine either way.
 */

import { dividerSections, matchDivider } from './divider';

export type FoldKind = 'indentation' | 'region';

/** A foldable span (0-based lines, `end` inclusive). */
export interface FoldRange {
    start: number;
    end: number;
    kind: FoldKind;
}

/** Leading-whitespace width, counting a tab as one column (good enough to rank siblings). */
function indentOf(line: string): number {
    const match = /^[ \t]*/.exec(line);
    return match ? match[0].length : 0;
}

const isBlank = (line: string): boolean => line.trim() === '';

/**
 * Divider sections plus indentation blocks. Sections come first so a client
 * that keeps insertion order shows the outer fold first; VS Code sorts them
 * itself, so the order is for readability, not correctness.
 *
 * Trailing blank lines are excluded from both kinds: folding a section down to
 * a run of empty lines looks like an off-by-one even though it collapses the
 * same content.
 */
export function computeFoldRanges(lines: readonly string[]): FoldRange[] {
    const ranges: FoldRange[] = [];

    for (const section of dividerSections(lines)) {
        const end = lastContentLine(lines, section.line, section.endLine);
        if (end > section.line) ranges.push({ start: section.line, end, kind: 'region' });
    }

    // Indentation blocks, stack-based: a line opens a block when a deeper line
    // follows, and the block closes at the last deeper line before a sibling.
    const stack: { line: number; indent: number }[] = [];
    let lastContent = -1;
    lines.forEach((text, line) => {
        if (isBlank(text)) return; // Blanks are transparent — they don't close a block.
        const indent = indentOf(text);
        while (
            stack.length > 0 &&
            (stack[stack.length - 1] as { indent: number }).indent >= indent
        ) {
            const open = stack.pop() as { line: number; indent: number };
            if (lastContent > open.line) {
                ranges.push({ start: open.line, end: lastContent, kind: 'indentation' });
            }
        }
        // A divider is a section header, not a parent: letting it open an
        // indentation block would duplicate the region fold it already has.
        if (matchDivider(text) === null) stack.push({ line, indent });
        lastContent = line;
    });
    while (stack.length > 0) {
        const open = stack.pop() as { line: number; indent: number };
        if (lastContent > open.line) {
            ranges.push({ start: open.line, end: lastContent, kind: 'indentation' });
        }
    }

    return ranges;
}

/** The last non-blank line in `[from, to]`, or `from` when the rest is blank. */
function lastContentLine(lines: readonly string[], from: number, to: number): number {
    for (let line = Math.min(to, lines.length - 1); line > from; line--) {
        if (!isBlank(lines[line] as string)) return line;
    }
    return from;
}
