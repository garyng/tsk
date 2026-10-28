/**
 * Single source of truth for the forward relationship edges a task can declare
 * via metadata (`@parent` / `@dependsOn` / `@relatedTo` / `@movedTo`).
 *
 * These keys had been re-declared as ad-hoc union literals, an iteration array,
 * and hand-listed `metadata.get` blocks across graph.ts, graph-service.ts,
 * cache.ts, codelens-logic.ts, and code-actions.ts — a missed site silently
 * dropped an edge with no compiler help. Derive everything from this one array
 * instead, mirroring the {@link MARKERS} / {@link PRIORITIES} registries.
 *
 * The *inverse* edges have asymmetric names (children / dependents / related /
 * movedHereFrom) and are built — and named — in graph.ts, so they stay there.
 */
export const RELATIONSHIP_KEYS = ['parent', 'dependsOn', 'relatedTo', 'movedTo'] as const;

/** One of the forward relationship metadata keys. Derived from {@link RELATIONSHIP_KEYS}. */
export type RelationshipKey = (typeof RELATIONSHIP_KEYS)[number];

const RELATIONSHIP_KEY_SET: ReadonlySet<string> = new Set(RELATIONSHIP_KEYS);

/** Narrow an untrusted string (e.g. the key in a {@link brokenRefCode}). */
export function isRelationshipKey(value: string): value is RelationshipKey {
    return RELATIONSHIP_KEY_SET.has(value);
}

const BROKEN_REF_PREFIX = 'broken-ref:';

/**
 * The code of a broken-reference diagnostic: `broken-ref:<key>:<target id>`.
 * It names the target as well as the key, so a quick fix can drop or replace
 * that one id of a `@dependsOn` list.
 */
export function brokenRefCode(key: RelationshipKey, targetId: string): string {
    return `${BROKEN_REF_PREFIX}${key}:${targetId}`;
}

/** Read a {@link brokenRefCode} back; `undefined` for any other diagnostic code. */
export function parseBrokenRefCode(
    code: unknown,
): { key: RelationshipKey; targetId: string } | undefined {
    if (typeof code !== 'string' || !code.startsWith(BROKEN_REF_PREFIX)) return undefined;
    const rest = code.slice(BROKEN_REF_PREFIX.length);
    const colon = rest.indexOf(':');
    if (colon < 0) return undefined;
    const key = rest.slice(0, colon);
    return isRelationshipKey(key) ? { key, targetId: rest.slice(colon + 1) } : undefined;
}

/**
 * The relationship key whose value is a comma list of ids (`@dependsOn:a,b`)
 * rather than one id — a task can wait on several others. One key with a list,
 * not a repeated key: metadata is a map where the later of two equal keys wins,
 * so `@dependsOn:a @dependsOn:b` would lose `a` the first time any tool
 * rewrote the line. Ids never contain a comma (`ids.ts`'s alphabet).
 */
export const LIST_KEY = 'dependsOn' satisfies RelationshipKey;

/** The ids in a `@dependsOn` value, in written order: trimmed, empties and repeats dropped. */
export function parseIdList(value: string | null | undefined): string[] {
    if (!value) return [];
    const ids: string[] = [];
    for (const raw of value.split(',')) {
        const id = raw.trim();
        if (id !== '' && !ids.includes(id)) ids.push(id);
    }
    return ids;
}

export function formatIdList(ids: readonly string[]): string {
    return ids.join(',');
}

/**
 * Project a task's metadata map onto its forward relationship edges, skipping
 * absent and value-less (`@flag`) keys. The single place that reads the
 * relationship keys out of a metadata map — both cache projection paths route
 * through it, so a key added to {@link RELATIONSHIP_KEYS} flows to the graph
 * automatically. (An empty-string value is kept, matching the prior `?? undefined`
 * behaviour; only `null`/absent are dropped.)
 */
export function readRelationships(
    metadata: ReadonlyMap<string, string | null>,
): Partial<Record<RelationshipKey, string>> {
    const out: Partial<Record<RelationshipKey, string>> = {};
    for (const key of RELATIONSHIP_KEYS) {
        const value = metadata.get(key);
        if (value != null) out[key] = value;
    }
    return out;
}
