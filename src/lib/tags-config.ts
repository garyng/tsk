import { parse as parseYaml } from 'yaml';

/**
 * A tag's optional metadata as declared in `tags.yml`. Both fields are
 * optional: a tag may be defined purely to surface a description, purely
 * to declare an explicit parent override, or as a bare entry with no
 * metadata at all (`{}` — discovered-but-not-described).
 */
export interface TagDef {
    description?: string;
    parent?: string;
}

/**
 * Parse a `tags.yml` document into an insertion-ordered map of tag name
 * to its definition. Two schema forms are accepted per the user-facing
 * spec:
 *
 *   string shorthand: `<tag name>: <description>`
 *   object form:      `<tag name>: { description?, parent? }`
 *
 * The parser is forgiving — empty / `null` / array / malformed inputs
 * all yield an empty `Map` rather than throwing. The activation layer
 * cannot afford a missing or invalid `tags.yml` to crash the extension.
 *
 * Per-entry tolerance: a value that is neither a string nor a plain
 * object is skipped (number, boolean, array). `null` is treated as a
 * bare entry (`{}`). In the object form, non-string `description` /
 * `parent` fields are dropped.
 */
export function parseTagsYaml(text: string): Map<string, TagDef> {
    const out = new Map<string, TagDef>();
    let parsed: unknown;
    try {
        parsed = parseYaml(text);
    } catch {
        return out;
    }
    if (parsed === null || parsed === undefined) return out;
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return out;

    for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
        if (name === '') continue;
        const def = coerceTagDef(raw);
        if (def !== null) out.set(name, def);
    }
    return out;
}

function coerceTagDef(raw: unknown): TagDef | null {
    if (raw === null || raw === undefined) return {};
    if (typeof raw === 'string') {
        return raw === '' ? {} : { description: raw };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    const def: TagDef = {};
    if (typeof obj.description === 'string' && obj.description !== '') {
        def.description = obj.description;
    }
    if (typeof obj.parent === 'string' && obj.parent !== '') {
        def.parent = obj.parent;
    }
    return def;
}

/**
 * Given an iterable of tag names, return the set of every tag plus its
 * implicit `/`-separated parents. `project/tsk` adds `project` (and
 * itself); `inventory/homelab/nas1` adds `inventory`, `inventory/homelab`,
 * and itself.
 *
 * Empty path segments (leading / trailing / doubled slashes) are
 * ignored — `a//b` contributes `a` and `a//b`, not `a/`.
 */
export function expandImplicitParents(tags: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const tag of tags) {
        if (tag === '') continue;
        const parts = tag.split('/');
        let prefix = '';
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (part === '' || part === undefined) {
                // Preserve the empty slot in the running prefix so the
                // final reconstruction matches the original string, but
                // don't add a prefix that ends on an empty segment as
                // its own implicit parent.
                prefix = prefix === '' ? '' : `${prefix}/`;
                continue;
            }
            prefix = prefix === '' ? part : `${prefix}/${part}`;
            out.add(prefix);
        }
        // Make sure the original (which may contain doubled or trailing
        // slashes that the prefix walk skipped) is also present.
        out.add(tag);
    }
    return out;
}

/**
 * Combine yaml-declared tag defs with the set of tags discovered in the
 * workspace cache, expanding implicit parents along the way. Yaml
 * entries keep their `description` / `parent`; discovered-only tags get
 * a bare `{}`.
 *
 * Iteration order: yaml entries first (in document order), then any
 * additional expanded-discovered tags in the order they were
 * encountered. Ordering matters for the completion provider's default
 * presentation — declared tags surface first, the long tail of
 * discovered-but-undocumented tags trails behind.
 */
export function mergeTagDefs(
    yamlDefs: ReadonlyMap<string, TagDef>,
    discoveredTags: Iterable<string>,
): Map<string, TagDef> {
    const out = new Map<string, TagDef>();
    for (const [name, def] of yamlDefs) {
        out.set(name, def);
    }
    for (const tag of expandImplicitParents(discoveredTags)) {
        if (!out.has(tag)) out.set(tag, {});
    }
    return out;
}
