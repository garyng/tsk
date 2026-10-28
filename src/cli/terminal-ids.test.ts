import { describe, expect, it } from 'vitest';
import { idsAsRefs } from './terminal-ids';

const cyan = (text: string) => `\u001B[36m${text}\u001B[39m`;

describe('idsAsRefs', () => {
    it("writes each task's id, after its marker, as tsk:<id> in cyan", () => {
        expect(
            idsAsRefs(
                'done  [x] snr4pzzy Reveal Task\n  1 [/] 5tdnqp74 #p/tsk tsk for Claude',
                true,
            ),
        ).toBe(
            `done  [x] ${cyan('tsk:snr4pzzy')} Reveal Task\n  1 [/] ${cyan('tsk:5tdnqp74')} #p/tsk tsk for Claude`,
        );
    });

    it('leaves the colour out when asked', () => {
        expect(idsAsRefs('[x] snr4pzzy Reveal Task', false)).toBe('[x] tsk:snr4pzzy Reveal Task');
    });

    it('leaves the rest alone: text without a marker, a marker the text quotes, a task with no id', () => {
        const plain = 'trail (session fa9660c6):\nopen under the focus:\n    [ ] (no id) a task';
        expect(idsAsRefs(plain, true)).toBe(plain);
        expect(idsAsRefs('see [x] marks', true)).toBe('see [x] marks');
    });
});
