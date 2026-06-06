/**
 * Pure logic for the `tsk.autolinks` feature: validate/compile the
 * user-configured regex→URL rules and turn a single line of text into link
 * spans. No `vscode` import — the activation layer (`autolinks-provider.ts`)
 * maps the returned {@link AutoLinkSpan}s onto `vscode.DocumentLink`s, the same
 * split `lib/decorations.ts` uses for its range computers.
 *
 * Substitution is native: the URL is `match[0].replace(reExpand, target)`, so
 * `$1` / `$<name>` / `$&` / `$$` follow `String.prototype.replace` semantics
 * exactly (no bespoke parser). Caveat: that re-runs `replace` on `match[0]` in
 * isolation, so a `target` whose `pattern` leans on a look-behind/look-ahead to
 * position the match won't re-satisfy it — the link range stays correct but the
 * substitution no-ops to the raw matched text.
 */

/** One rule as it arrives from settings (`tsk.autolinks[i]`). */
export interface AutoLinkRule {
    pattern: string;
    target: string;
    flags?: string;
}

/** A validated rule: two pre-compiled regexes + the URL template. */
export interface CompiledAutoLink {
    /** Global — drives `matchAll` so every occurrence becomes a link. */
    reAll: RegExp;
    /** Non-global — drives the per-match substitution `replace`. */
    reExpand: RegExp;
    target: string;
}

/** A resolved link location on one line (cols are 0-based, `endCol` exclusive). */
export interface AutoLinkSpan {
    startCol: number;
    endCol: number;
    target: string;
}

/** Outcome of {@link parseAutoLinkRules}: usable rules + human-readable skips. */
export interface ParsedAutoLinks {
    rules: CompiledAutoLink[];
    warnings: string[];
}

/** Regex flags a user may supply; `g` is implied and forced onto `reAll`. */
const ALLOWED_USER_FLAGS = 'imsu';

/**
 * Validate + compile `tsk.autolinks` into {@link CompiledAutoLink}s. Forgiving
 * like the `tags.yml` parser: a malformed entry is skipped with a warning
 * rather than thrown, so one bad rule never disables the rest (or the
 * extension). Accepts `unknown` so it can guard whatever settings hand back.
 */
export function parseAutoLinkRules(raw: unknown): ParsedAutoLinks {
    const rules: CompiledAutoLink[] = [];
    const warnings: string[] = [];
    if (!Array.isArray(raw)) {
        if (raw !== undefined && raw !== null) warnings.push('tsk.autolinks: expected an array.');
        return { rules, warnings };
    }
    for (const [i, entry] of raw.entries()) {
        const compiled = compileRule(entry, i, warnings);
        if (compiled) rules.push(compiled);
    }
    return { rules, warnings };
}

function compileRule(entry: unknown, i: number, warnings: string[]): CompiledAutoLink | null {
    const at = `tsk.autolinks[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        warnings.push(`${at}: not an object.`);
        return null;
    }
    const { pattern, target, flags } = entry as Record<string, unknown>;
    if (typeof pattern !== 'string' || pattern === '') {
        warnings.push(`${at}: "pattern" must be a non-empty string.`);
        return null;
    }
    if (typeof target !== 'string' || target === '') {
        warnings.push(`${at}: "target" must be a non-empty string.`);
        return null;
    }
    let userFlags = '';
    if (flags !== undefined) {
        if (typeof flags !== 'string') {
            warnings.push(`${at}: "flags" must be a string.`);
            return null;
        }
        const normalized = normalizeFlags(flags);
        if (normalized === null) {
            warnings.push(
                `${at}: "flags" may only contain ${[...ALLOWED_USER_FLAGS].join('/')} (got "${flags}").`,
            );
            return null;
        }
        userFlags = normalized;
    }
    try {
        return {
            reAll: new RegExp(pattern, `${userFlags}g`),
            reExpand: new RegExp(pattern, userFlags),
            target,
        };
    } catch (err) {
        warnings.push(`${at}: invalid regex ${JSON.stringify(pattern)}: ${(err as Error).message}`);
        return null;
    }
}

/**
 * Drop an implied `g`, then accept only {@link ALLOWED_USER_FLAGS}; returns the
 * sanitized flag string, or `null` on a disallowed (`y`/`d`/junk) or duplicate
 * flag. `g`/`y` would change the matching semantics this module controls, so
 * they can't be passed through.
 */
function normalizeFlags(flags: string): string | null {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const ch of flags) {
        if (ch === 'g') continue; // implied — added to reAll explicitly
        if (!ALLOWED_USER_FLAGS.includes(ch) || seen.has(ch)) return null;
        seen.add(ch);
        out.push(ch);
    }
    return out.join('');
}

/**
 * Find every link on `line`: run each rule's global regex, build the URL per
 * match via native `replace`, then resolve overlaps. Earlier rules win, then
 * left-most; a later span overlapping an accepted one is dropped (VS Code
 * rejects overlapping `DocumentLink`s). Zero-width matches and empty
 * substitutions are skipped.
 */
export function computeAutoLinkSpans(
    line: string,
    rules: readonly CompiledAutoLink[],
): AutoLinkSpan[] {
    const candidates: AutoLinkSpan[] = [];
    for (const rule of rules) {
        for (const match of line.matchAll(rule.reAll)) {
            const text = match[0];
            if (text === '' || match.index === undefined) continue;
            const target = text.replace(rule.reExpand, rule.target);
            if (target === '') continue;
            candidates.push({ startCol: match.index, endCol: match.index + text.length, target });
        }
    }
    return resolveOverlaps(candidates);
}

/**
 * Greedily accept candidates in priority order (the caller emits them
 * rule-by-rule, each rule left-to-right), dropping any that overlaps an
 * already-accepted span; then sort survivors by position for a stable,
 * left-to-right result.
 */
function resolveOverlaps(candidates: AutoLinkSpan[]): AutoLinkSpan[] {
    const accepted: AutoLinkSpan[] = [];
    for (const c of candidates) {
        if (!accepted.some((a) => c.startCol < a.endCol && a.startCol < c.endCol)) {
            accepted.push(c);
        }
    }
    accepted.sort((a, b) => a.startCol - b.startCol);
    return accepted;
}
