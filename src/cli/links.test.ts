import { describe, expect, it } from 'vitest';
import { linkIds } from './links';

/** OSC 8, as the spec writes it: the link, the text, the end of the link, each ended by ST. */
const link = (id: string) =>
    `\u001B]8;;vscode://garyng.tsk/open?id=${id}\u001B\\${id}\u001B]8;;\u001B\\`;

describe('linkIds', () => {
    it("links each task's id, after its marker, to the extension's URI", () => {
        expect(
            linkIds('done  [x] snr4pzzy Reveal Task\n  1 [/] 5tdnqp74 #p/tsk tsk for Claude'),
        ).toBe(
            `done  [x] ${link('snr4pzzy')} Reveal Task\n  1 [/] ${link('5tdnqp74')} #p/tsk tsk for Claude`,
        );
    });

    it('leaves the rest alone: text without a marker, a marker the text quotes, a task with no id', () => {
        const plain = 'trail (session fa9660c6):\nopen under the focus:\n    [ ] (no id) a task';
        expect(linkIds(plain)).toBe(plain);
        expect(linkIds('see [x] marks')).toBe('see [x] marks');
    });
});
