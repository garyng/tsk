import { GLYPH } from './markers';
import { serializeMetadata } from './metadata';
import type { ParsedTask } from './parser';

/**
 * Pure logic behind `Tsk: Move Task to File…` — compute the indented block a
 * task owns, re-base it to column 0, and build the `[>]` breadcrumb that stays
 * behind. No `vscode`; the activation layer (`move-task-commands.ts`) turns
 * these into a single `WorkspaceEdit`.
 */

/** Inline-tag matcher (mirrors the parser's `TAG_RE`) — for stripping tags from the stub. */
const TAG_RE = /(?:^|\s)#[A-Za-z][A-Za-z0-9_/-]*/g;

const isBlank = (line: string): boolean => line.trim() === '';

/**
 * Visual indent column of `line`: a leading space counts 1, a tab advances to
 * the next `tabSize` multiple; stops at the first non-whitespace char. Comparing
 * by column (not raw char count) keeps tab- and space-indented files honest.
 */
function indentColumn(line: string, tabSize: number): number {
    let col = 0;
    for (const ch of line) {
        if (ch === ' ') col += 1;
        else if (ch === '\t') col += tabSize - (col % tabSize);
        else break;
    }
    return col;
}

/**
 * The inclusive `{ start, end }` line range of a task's block: the task line
 * plus every line nested beneath it (a deeper indent column). Interior blank
 * lines are kept (they belong to the block when deeper content follows); blank
 * lines trailing the block are excluded. A sibling or ancestor line ends it.
 */
export function computeTaskBlockRange(
    lines: readonly string[],
    taskLine: number,
    tabSize: number,
): { start: number; end: number } {
    const parentCol = indentColumn(lines[taskLine] ?? '', tabSize);
    let end = taskLine;
    for (let j = taskLine + 1; j < lines.length; j++) {
        const line = lines[j] as string;
        if (isBlank(line)) continue; // tentative — kept only if a deeper line follows
        if (indentColumn(line, tabSize) > parentCol) end = j;
        else break; // sibling or ancestor closes the block
    }
    return { start: taskLine, end };
}

/** A document range, as raw line/char coordinates — the activation layer maps it to a `vscode.Range`. */
export interface DeletionSpan {
    startLine: number;
    startChar: number;
    endLine: number;
    endChar: number;
}

/**
 * The range that deletes a task block (lines `[start, end]`) *including* a line
 * terminator, so no blank line is orphaned where the block used to be. Used by
 * `Extract Task to File` (Move replaces the block with a breadcrumb instead, so
 * the surrounding newlines stay put). `prevLineLen` / `lastLineLen` are the
 * char-lengths of lines `start-1` and `end`; only consulted in the EOF cases.
 *
 * - **Block not at EOF** (`end < lineCount-1`) → consume the newline AFTER the
 *   block: `(start,0) → (end+1,0)`. (A block followed by a file-final blank line
 *   lands here — the blank stays, the block's own terminator goes.)
 * - **Block at EOF with a line above it** → consume the newline BEFORE the
 *   block: `(start-1, prevLineLen) → (end, lastLineLen)`.
 * - **Block IS the whole file** (`start === 0 && end === lineCount-1`) →
 *   `(0,0) → (end, lastLineLen)`, emptying the document.
 */
export function computeBlockDeletion(
    lineCount: number,
    start: number,
    end: number,
    prevLineLen: number,
    lastLineLen: number,
): DeletionSpan {
    if (end < lineCount - 1) {
        return { startLine: start, startChar: 0, endLine: end + 1, endChar: 0 };
    }
    if (start > 0) {
        return { startLine: start - 1, startChar: prevLineLen, endLine: end, endChar: lastLineLen };
    }
    return { startLine: 0, startChar: 0, endLine: end, endChar: lastLineLen };
}

/**
 * Re-base a block to column 0 by stripping the parent's literal indent `prefix`
 * from each line. Children share that prefix (plus more), so they keep their
 * relative depth; blank lines collapse to empty. Correct under any tab/space mix
 * (a prefix strip, not column arithmetic).
 */
export function dedentBlock(blockLines: readonly string[], prefix: string): string[] {
    return blockLines.map((line) => {
        if (isBlank(line)) return '';
        return line.startsWith(prefix) ? line.slice(prefix.length) : line;
    });
}

/** Drop inline `#tags` from `content` and tidy the leftover whitespace. */
function stripTags(content: string): string {
    return content.replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The `[>]` breadcrumb that replaces the relocated task in the source file.
 * Keeps the task's bullet, indentation, and (tag-stripped) content; takes a
 * FRESH `@id` — it cannot reuse `originalId`, which now lives on the relocated
 * task — and wires `@movedTo:<originalId>` + `@moved:<nowIso>` so the existing
 * moved-marker codelens resolves stub → relocated task. Throws if the task has
 * no `@id` (the command rejects that upstream).
 */
export function buildMoveStub(task: ParsedTask, freshId: string, nowIso: string): string {
    const originalId = task.metadata.get('id');
    if (!originalId) throw new Error('buildMoveStub: task has no @id to point @movedTo at');
    const bullet = task.raw[task.indent.length] ?? '-';
    const content = stripTags(task.content);
    const comment = serializeMetadata(
        new Map<string, string | null>([
            ['id', freshId],
            ['movedTo', originalId],
            ['moved', nowIso],
        ]),
    );
    const marker = `[${GLYPH.moved}]`;
    return content
        ? `${task.indent}${bullet} ${marker} ${content} ${comment}`
        : `${task.indent}${bullet} ${marker} ${comment}`;
}

/**
 * Text to append the relocated block to a destination file's end. Empty target
 * → just the block; non-empty → a blank-line separator first (one `eol` when the
 * file already ends in a newline, two otherwise), always a trailing newline. The
 * caller inserts this at the end of the document.
 */
export function buildAppendText(
    existing: string,
    destLines: readonly string[],
    eol: string,
): string {
    const block = destLines.join(eol);
    if (existing.trim() === '') return `${block}${eol}`;
    const separator = existing.endsWith('\n') ? eol : `${eol}${eol}`;
    return `${separator}${block}${eol}`;
}
