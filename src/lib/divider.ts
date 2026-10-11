/**
 * Pure core of the divider-line feature. A divider is a labelled section
 * break written as a leading `-`, a label, then a run of dashes:
 *
 * ```
 * -todo-------------------------------------------------------------------
 * -focus------------------------------------------------------------------
 * ```
 *
 * The syntax is taken from how these are already written by hand (typically
 * ~100 columns wide, but the width is a convention, not a contract —
 * {@link formatDivider} normalises new ones without invalidating old).
 *
 * **Why it can't collide with a task or a bullet:** a task line needs
 * `[-*+]\s+\[` and a bare bullet needs `[-*+]\s+` (`parser.ts`'s
 * `TASK_LINE_RE` / `BULLET_LINE_RE`) — both require whitespace after the
 * bullet character. `-todo---` has none, so it parses as neither today and
 * cannot start to tomorrow. A bare `---` horizontal rule is excluded from the
 * other side: the label must open with an alphanumeric.
 */

/** A matched divider line, located for folding and for styling the dash run. */
export interface Divider {
    /** Leading whitespace, verbatim. */
    indent: string;
    /** The section name between the leading `-` and the dash run. */
    label: string;
    /** Column of the leading `-`. */
    startCol: number;
    /** Column where the trailing dash run begins. */
    dashStartCol: number;
    /** Column just past the last dash (trailing whitespace excluded). */
    endCol: number;
}

/**
 * `-<label>` followed by at least three dashes. The label is lazy and may
 * itself contain dashes (`-a-b-----` labels `a-b`), so the split lands on the
 * earliest position where a dash run reaches end-of-line — which is what makes
 * a divider require dashes at the END, not merely somewhere.
 */
const DIVIDER_RE = /^(\s*)-([A-Za-z0-9][\w/ -]*?)(-{3,})\s*$/;

/** The minimum dash run a divider needs, mirrored in {@link formatDivider}. */
const MIN_DASHES = 3;

/** Match `line` as a divider, or `null`. */
export function matchDivider(line: string): Divider | null {
    const match = DIVIDER_RE.exec(line);
    if (!match) return null;
    const [, indent, label, dashes] = match as unknown as [string, string, string, string];
    const startCol = indent.length;
    // `-` + label, then the dashes.
    const dashStartCol = startCol + 1 + label.length;
    return {
        indent,
        label,
        startCol,
        dashStartCol,
        endCol: dashStartCol + dashes.length,
    };
}

/**
 * Render a divider for `label`, padded with dashes to `width` columns. A label
 * too long to leave {@link MIN_DASHES} still gets that many, so the result is
 * always a line {@link matchDivider} accepts — a formatter that can emit
 * something its own parser rejects is a bug waiting to happen.
 */
export function formatDivider(label: string, width: number): string {
    const trimmed = label.trim();
    const head = `-${trimmed}`;
    const dashes = Math.max(MIN_DASHES, width - head.length);
    return head + '-'.repeat(dashes);
}

/** A divider-delimited section: the divider's line, and the last line it covers. */
export interface DividerSection {
    /** Line of the divider itself. */
    line: number;
    /** Last line belonging to this section (inclusive). */
    endLine: number;
    label: string;
}

/**
 * Split `lines` into divider-delimited sections. Each divider owns everything
 * up to the line before the next divider, or the end of the file; content
 * above the first divider belongs to no section. Returns one entry per
 * divider, so a caller can map them straight onto folding ranges.
 *
 * A divider immediately followed by another yields a section of just itself
 * (`endLine === line`) — hand-maintained files do this, two dividers on
 * adjacent lines.
 */
export function dividerSections(lines: readonly string[]): DividerSection[] {
    const dividers: { line: number; label: string }[] = [];
    lines.forEach((text, line) => {
        const divider = matchDivider(text);
        if (divider) dividers.push({ line, label: divider.label });
    });
    return dividers.map((divider, i) => ({
        line: divider.line,
        label: divider.label,
        endLine: (dividers[i + 1]?.line ?? lines.length) - 1,
    }));
}

/** How `tsk.insertDivider` should apply itself to the line the cursor is on. */
export interface DividerPlacement {
    /** `replace` overwrites the current line; `insertBelow` adds one after it. */
    mode: 'replace' | 'insertBelow';
    /** The existing label, when the cursor is already on a divider (prefills the prompt). */
    existingLabel?: string;
}

/**
 * Decide where a divider goes. A blank line becomes the divider (that's where
 * you are when you want one); a line that already IS a divider is edited in
 * place, which doubles as the re-pad path after a label is renamed; anything
 * else gets a new line below, so a divider never eats content.
 */
export function dividerPlacement(lineText: string): DividerPlacement {
    const existing = matchDivider(lineText);
    if (existing) return { mode: 'replace', existingLabel: existing.label };
    if (lineText.trim() === '') return { mode: 'replace' };
    return { mode: 'insertBelow' };
}
