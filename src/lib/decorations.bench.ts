import { bench, describe } from 'vitest';
import { computeMarkerRanges, computeMetadataRanges, computePriorityRanges } from './decorations';
import { parseDocument } from './parser';

/**
 * Quantifies the per-focus work the M40 version cache eliminates: a full
 * `parseDocument` + the `compute*Ranges` passes over a whole document.
 * `DecorationsController.applyToEditor` ran this on *every* editor focus before
 * M40; the cache now reuses the result whenever `document.version` is unchanged.
 *
 * Run: `npm run bench`.
 */
function makeDoc(taskCount: number): string {
    const markers = ['[ ]', '[/]', '[x]', '[!]', '[n]', '[>]'];
    const lines: string[] = ['# benchmark doc', ''];
    for (let i = 0; i < taskCount; i++) {
        const marker = markers[i % markers.length];
        const priority = (i % 3) + 1;
        lines.push(
            `- ${marker} task number ${i} with some descriptive text #project/area/sub <!-- @id:bench${i} @created:2026-05-20T09:00:00+08:00 @priority:${priority} -->`,
        );
    }
    return lines.join('\n');
}

for (const taskCount of [200, 1000, 5000]) {
    const text = makeDoc(taskCount);
    describe(`decoration recompute — ${taskCount} tasks`, () => {
        bench('parseDocument only', () => {
            parseDocument(text);
        });
        bench('parse + compute (the full per-focus recompute the cache skips)', () => {
            const tasks = parseDocument(text);
            computeMarkerRanges(tasks);
            computePriorityRanges(tasks);
            computeMetadataRanges(tasks);
        });
    });
}
