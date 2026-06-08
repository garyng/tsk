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

/** Narrow an untrusted string (e.g. a `broken-ref:<key>` diagnostic code suffix). */
export function isRelationshipKey(value: string): value is RelationshipKey {
    return RELATIONSHIP_KEY_SET.has(value);
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
