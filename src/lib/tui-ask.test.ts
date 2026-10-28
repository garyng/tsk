import { describe, expect, it } from 'vitest';
import { deliveryOf, elapsed, messageText } from './tui-ask';

const subject = { id: 'abc12345', title: 'the detail pane', file: 'claude.tsk' };

describe('messageText', () => {
    it('names several tasks file by file', () => {
        const b = { id: 'b', title: 'step b', file: 'claude.tsk' };
        const back = { id: 'back1', title: 'the backlog item', file: 'stack.tsk' };
        expect(messageText([subject, b, back], 'do these')).toContain(
            'about tsk:abc12345 "the detail pane" and tsk:b "step b" in claude.tsk and tsk:back1 "the backlog item" in stack.tsk, the user says: "do these".',
        );
    });

    it('says where it comes from, which task in which file, and what the user typed, trimmed', () => {
        expect(messageText([subject], '  mark it done \n')).toBe(
            'From the tsk pane beside this session, about tsk:abc12345 "the detail pane" in claude.tsk, the user says: "mark it done". If it asks for something other than what you\'re doing, bring that to a safe point first.',
        );
    });
});

/** Transcript lines as Claude Code 2.1.296 wrote them in the spike, cut to the fields read. */
const text = messageText([subject], 'mark it done');
const pid = 4242;
const line = (o: object) => JSON.stringify(o);

describe('deliveryOf', () => {
    it('is queued when the session takes the line into its queue', () => {
        expect(
            deliveryOf(line({ type: 'queue-operation', operation: 'enqueue', content: text }), {
                text,
                pid,
            }),
        ).toBe('queued');
    });
    it('is read when an idle session starts a turn with it', () => {
        const entry = {
            type: 'user',
            origin: { kind: 'peer', from: 'unknown', verifiedPeerPid: pid },
            message: {
                role: 'user',
                content: `Another Claude session sent a message:\n${text}\n\nThis came from…`,
            },
        };
        expect(deliveryOf(line(entry), { text, pid })).toBe('read');
    });
    it('is read when a busy session folds it in between tool calls', () => {
        const removed = {
            type: 'queue-operation',
            operation: 'remove',
            content: text,
            reason: 'absorbed_mid_turn',
        };
        const attachment = {
            type: 'attachment',
            attachment: {
                type: 'queued_command',
                prompt: text,
                origin: { kind: 'peer', verifiedPeerPid: pid },
            },
        };
        expect(deliveryOf(line(removed), { text, pid })).toBe('read');
        expect(deliveryOf(line(attachment), { text, pid })).toBe('read');
    });
    it('is removed when the queue drops it any other way', () => {
        const removed = {
            type: 'queue-operation',
            operation: 'remove',
            content: text,
            reason: 'cleared',
        };
        expect(deliveryOf(line(removed), { text, pid })).toBe('removed');
    });
    it("ignores other messages, other posters, a dequeue (it carries no text) and lines that don't parse", () => {
        const other = { type: 'queue-operation', operation: 'enqueue', content: 'something else' };
        const otherPid = {
            type: 'user',
            origin: { verifiedPeerPid: 1 },
            message: { content: text },
        };
        const dequeue = { type: 'queue-operation', operation: 'dequeue' };
        for (const l of [line(other), line(otherPid), line(dequeue), '{"type":"user"', 'null', ''])
            expect(deliveryOf(l, { text, pid })).toBeUndefined();
    });
});

describe('elapsed', () => {
    it('reads as m:ss', () => {
        expect(elapsed(0)).toBe('0:00');
        expect(elapsed(80_500)).toBe('1:20');
        expect(elapsed(-5)).toBe('0:00');
    });
});
