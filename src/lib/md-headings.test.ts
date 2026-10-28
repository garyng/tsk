import { describe, expect, it } from 'vitest';
import { headingFor, headingLine, markdownHeadings } from './md-headings';

const plan = [
    '# tsk for Claude', // 0
    '',
    '## 4. Design',
    '',
    '### 4.6 Links between plans and tasks', // 4
    '',
    '```md',
    '## not a heading, inside a fence', // 7
    '```',
    '',
    '## Notes', // 10
    '',
    '## Notes', // 12
    '',
    'Setext `heading` & more', // 14
    '===',
    '',
    '## A [link](https://example.com) and **bold**', // 17
].join('\n');

describe('headingFor', () => {
    it('finds the heading a fragment names among headings read once, with its text', () => {
        const headings = markdownHeadings(plan);
        expect(headingFor(headings, '46-links-between-plans-and-tasks')?.text).toBe(
            '4.6 Links between plans and tasks',
        );
        expect(headingFor(headings, 'notes-1')?.line).toBe(12);
        expect(headingFor(headings, 'nowhere')).toBeUndefined();
    });
});

describe('headingLine', () => {
    it('finds a heading by its GitHub anchor', () => {
        expect(headingLine(plan, 'tsk-for-claude')).toBe(0);
        expect(headingLine(plan, '46-links-between-plans-and-tasks')).toBe(4);
    });

    it('takes the heading text too, slugged the same way', () => {
        expect(headingLine(plan, '4.6 Links between plans and tasks')).toBe(4);
        expect(headingLine(plan, 'TSK for Claude')).toBe(0);
    });

    it('numbers a repeated heading as GitHub does', () => {
        expect(headingLine(plan, 'notes')).toBe(10);
        expect(headingLine(plan, 'notes-1')).toBe(12);
    });

    it('slugs the rendered text: no code ticks, link targets or emphasis marks', () => {
        expect(headingLine(plan, 'setext-heading--more')).toBe(14);
        expect(headingLine(plan, 'a-link-and-bold')).toBe(17);
    });

    it('skips fenced code, and is undefined for a heading nobody wrote', () => {
        expect(headingLine(plan, 'not-a-heading-inside-a-fence')).toBeUndefined();
        expect(headingLine(plan, 'phase-9')).toBeUndefined();
    });

    it('counts lines the same with Windows line endings', () => {
        expect(headingLine(plan.replaceAll('\n', '\r\n'), 'notes-1')).toBe(12);
    });
});

describe('markdownHeadings', () => {
    it('lists the top-level headings in order, with their text, anchor and line', () => {
        expect(markdownHeadings(plan)).toEqual([
            { text: 'tsk for Claude', anchor: 'tsk-for-claude', line: 0 },
            { text: '4. Design', anchor: '4-design', line: 2 },
            {
                text: '4.6 Links between plans and tasks',
                anchor: '46-links-between-plans-and-tasks',
                line: 4,
            },
            { text: 'Notes', anchor: 'notes', line: 10 },
            { text: 'Notes', anchor: 'notes-1', line: 12 },
            { text: 'Setext heading & more', anchor: 'setext-heading--more', line: 14 },
            { text: 'A link and bold', anchor: 'a-link-and-bold', line: 17 },
        ]);
    });

    it('is empty for a file with no headings', () => {
        expect(markdownHeadings('just text\n\n- a list\n')).toEqual([]);
    });
});
