import { describe, expect, it } from 'vitest';
import { Logger } from './logger';

function makeSink() {
    const lines: string[] = [];
    return {
        lines,
        sink: { appendLine: (m: string) => lines.push(m) },
    };
}

describe('Logger', () => {
    it('writes when level meets threshold', () => {
        const { lines, sink } = makeSink();
        const log = new Logger(sink, 'info');
        log.info('hello');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/\[info] hello$/);
    });

    it('suppresses messages below the threshold', () => {
        const { lines, sink } = makeSink();
        const log = new Logger(sink, 'warn');
        log.debug('skip');
        log.info('skip');
        log.warn('keep');
        log.error('keep');
        expect(lines.map((line) => line.replace(/^\[[^\]]+] /, ''))).toEqual([
            '[warn] keep',
            '[error] keep',
        ]);
    });

    it('honors setLevel changes mid-stream', () => {
        const { lines, sink } = makeSink();
        const log = new Logger(sink, 'error');
        log.info('skip');
        log.setLevel('info');
        log.info('keep');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/\[info] keep$/);
    });

    it('includes an ISO timestamp and the level in each line', () => {
        const { lines, sink } = makeSink();
        const log = new Logger(sink, 'debug');
        log.debug('msg');
        expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z] \[debug] msg$/);
    });
});
