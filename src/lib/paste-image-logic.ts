import { format } from 'date-fns';

/**
 * Pure helpers behind the paste-image provider (M23). Everything here is
 * vscode-free so it unit-tests under vitest; the glue in
 * `src/paste-image.ts` binds these to a real `DocumentPasteEditProvider`,
 * the clipboard's `DataTransfer`, an input box, and disk I/O.
 */

/**
 * Image MIME types we save on paste, mapped to the on-disk extension we
 * give the saved file. Keyed by the lowercase MIME so lookups can
 * normalise first (the `DataTransfer.get` contract is case-insensitive, so
 * we don't rely on VSCode's casing).
 *
 * `image/jpeg` → `jpg` (not `jpeg`) to match the conventional extension.
 * SVG is included because it pastes as `image/svg+xml` from some apps and
 * round-trips fine as a Markdown image.
 */
export const IMAGE_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
};

/** The MIME types the provider asks to be invoked for, in priority order. */
export const SUPPORTED_IMAGE_MIMES: readonly string[] = Object.keys(IMAGE_MIME_EXTENSIONS);

/** Map a clipboard MIME to its file extension, or `undefined` if unsupported. */
export function extensionForMime(mime: string): string | undefined {
    return IMAGE_MIME_EXTENSIONS[mime.toLowerCase()];
}

/**
 * Local-time timestamp stem, `YYYY-MM-DDTHH-mm-ss`. Colons (illegal in
 * Windows filenames) are rendered as `-`, so the whole stem is portable.
 */
export function timestampStem(date: Date): string {
    return format(date, "yyyy-MM-dd'T'HH-mm-ss");
}

/** The fallback filename used when there's no selection: `<timestamp>.<ext>`. */
export function defaultImageFilename(now: Date, ext: string): string {
    return `${timestampStem(now)}.${ext}`;
}

/**
 * Ensure `name` carries the image extension. We deliberately do NOT mangle
 * the rest of the name (the selection is used verbatim, per M23's "warn,
 * don't sanitise" rule) — we only guarantee the file lands with the right
 * type suffix. If the name already ends in `.<ext>` (case-insensitive) it's
 * left untouched; otherwise `.<ext>` is appended (so `chart.v2` becomes
 * `chart.v2.png`, which is intentional — better a redundant suffix than a
 * PNG saved as `.v2`).
 */
export function ensureExtension(name: string, ext: string): string {
    return name.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? name : `${name}.${ext}`;
}

/**
 * Characters illegal in a path *segment* on Windows (a superset of POSIX),
 * minus the separators `/` and `\` — those are allowed because a selection
 * may name subdirectories (`tsk.pasteImage.baseDirectory` is prepended, then
 * the selection, which can itself be a relative path).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: paths must reject control chars
const ILLEGAL_PATH_CHARS = /[<>:"|?*\u0000-\u001f]/;

/**
 * Validate a selection-derived image path. Returns a human-readable error
 * message when the text can't be used as a relative path, or `undefined`
 * when it's fine. Used to *warn* on a bad selection rather than silently
 * rewriting it — the M23 design choice is that the user sees exactly what
 * they selected become the path, or gets told why it can't.
 *
 * Separators are allowed (the selection may carry subdirectories); only the
 * Windows-illegal punctuation and control characters are rejected.
 */
export function validateImagePath(name: string): string | undefined {
    const trimmed = name.trim();
    if (!trimmed) return 'the selection is empty';
    if (ILLEGAL_PATH_CHARS.test(trimmed)) {
        return 'the selection contains characters not allowed in a path';
    }
    return undefined;
}

/** Escape the snippet-significant characters (`\`, `$`, `}`) in literal text. */
function escapeSnippet(text: string): string {
    return text.replace(/[\\$}]/g, '\\$&');
}

/**
 * Build the Markdown image insertion as a VSCode *snippet* string. The alt
 * text is a `${1:…}` placeholder so that, on paste, it lands selected and
 * ready to overtype (M23 follow-up). The destination is angle-bracket
 * wrapped when it contains a space (the CommonMark escape for spaces in link
 * destinations) so `![alt](<my file.png>)` stays a valid image. Both the alt
 * and the destination are snippet-escaped so a literal `$`/`}`/`\` in either
 * can't be misread as snippet syntax.
 */
export function buildImageMarkdownSnippet(altText: string, relativePath: string): string {
    const destination = relativePath.includes(' ') ? `<${relativePath}>` : relativePath;
    return `![\${1:${escapeSnippet(altText)}}](${escapeSnippet(destination)})`;
}
