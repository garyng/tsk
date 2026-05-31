import { describe, expect, it } from 'vitest';
import {
    buildImageMarkdownSnippet,
    defaultImageFilename,
    ensureExtension,
    extensionForMime,
    SUPPORTED_IMAGE_MIMES,
    timestampStem,
    validateImagePath,
} from './paste-image-logic';

describe('extensionForMime', () => {
    it('maps known image MIMEs to conventional extensions', () => {
        expect(extensionForMime('image/png')).toBe('png');
        expect(extensionForMime('image/jpeg')).toBe('jpg');
        expect(extensionForMime('image/gif')).toBe('gif');
        expect(extensionForMime('image/webp')).toBe('webp');
        expect(extensionForMime('image/svg+xml')).toBe('svg');
    });

    it('is case-insensitive on the MIME', () => {
        expect(extensionForMime('IMAGE/PNG')).toBe('png');
    });

    it('returns undefined for unsupported types', () => {
        expect(extensionForMime('text/plain')).toBeUndefined();
        expect(extensionForMime('application/pdf')).toBeUndefined();
    });

    it('SUPPORTED_IMAGE_MIMES lists every mapped MIME', () => {
        expect(SUPPORTED_IMAGE_MIMES).toContain('image/png');
        for (const mime of SUPPORTED_IMAGE_MIMES) {
            expect(extensionForMime(mime)).toBeDefined();
        }
    });
});

describe('timestampStem', () => {
    it('renders local time with dashes (no colons)', () => {
        // Construct from local components so the assertion is timezone-stable.
        const d = new Date(2026, 4, 30, 9, 7, 3); // 2026-05-30 09:07:03 local
        expect(timestampStem(d)).toBe('2026-05-30T09-07-03');
    });
});

describe('defaultImageFilename', () => {
    it('joins the timestamp stem with the MIME-derived extension', () => {
        const d = new Date(2026, 0, 2, 3, 4, 5);
        expect(defaultImageFilename(d, 'png')).toBe('2026-01-02T03-04-05.png');
        expect(defaultImageFilename(d, 'jpg')).toBe('2026-01-02T03-04-05.jpg');
    });
});

describe('ensureExtension', () => {
    it('appends the extension when absent', () => {
        expect(ensureExtension('diagram', 'png')).toBe('diagram.png');
    });

    it('leaves a name that already ends in the extension (case-insensitive)', () => {
        expect(ensureExtension('shot.png', 'png')).toBe('shot.png');
        expect(ensureExtension('Shot.PNG', 'png')).toBe('Shot.PNG');
    });

    it('appends even when the name has a different trailing dotted segment', () => {
        // Intentional: better a redundant suffix than mislabelling the bytes.
        expect(ensureExtension('chart.v2', 'png')).toBe('chart.v2.png');
    });

    it('does not mangle spaces or other characters in the name', () => {
        expect(ensureExtension('My Diagram v2', 'png')).toBe('My Diagram v2.png');
    });
});

describe('validateImagePath', () => {
    it('accepts an ordinary name (returns no error)', () => {
        expect(validateImagePath('My Diagram v2')).toBeUndefined();
        expect(validateImagePath('a-b_c.123')).toBeUndefined();
    });

    it('accepts a selection containing path separators (subdirectories)', () => {
        expect(validateImagePath('sub/dir/shot')).toBeUndefined();
        expect(validateImagePath('sub\\dir\\shot')).toBeUndefined();
    });

    it('rejects an empty / whitespace-only selection', () => {
        expect(validateImagePath('')).toMatch(/empty/);
        expect(validateImagePath('   ')).toMatch(/empty/);
    });

    it('rejects Windows-illegal characters', () => {
        expect(validateImagePath('a<b')).toMatch(/not allowed/);
        expect(validateImagePath('a:b')).toMatch(/not allowed/);
        expect(validateImagePath('q?x')).toMatch(/not allowed/);
        expect(validateImagePath('star*')).toMatch(/not allowed/);
    });

    it('rejects control characters', () => {
        expect(validateImagePath('tab\tname')).toMatch(/not allowed/);
    });
});

describe('buildImageMarkdownSnippet', () => {
    it('makes the alt text a ${1} placeholder so it lands selected', () => {
        expect(buildImageMarkdownSnippet('shot', './images/shot.png')).toBe(
            '![${1:shot}](./images/shot.png)',
        );
    });

    it('angle-wraps a destination containing a space', () => {
        expect(buildImageMarkdownSnippet('a b', './images/a b.png')).toBe(
            '![${1:a b}](<./images/a b.png>)',
        );
    });

    it('snippet-escapes $, }, and \\ in the alt and destination', () => {
        expect(buildImageMarkdownSnippet('a}$b', './x$y/z}.png')).toBe(
            '![${1:a\\}\\$b}](./x\\$y/z\\}.png)',
        );
    });
});
