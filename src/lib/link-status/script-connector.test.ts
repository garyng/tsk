import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseScriptConnectors, readAnswers, scriptConnector } from './script-connector';

describe('parseScriptConnectors', () => {
    it('keeps the good entries and says what is wrong with the rest', () => {
        const { configs, warnings } = parseScriptConnectors([
            { name: 'tickets', match: '^https://t\\.example/', command: ['/bin/t', '--json'] },
            { name: 'big', match: 'x', command: ['t'], batchSize: 500 },
            { name: '', match: 'x', command: ['t'] },
            { name: 'bad re', match: '(', command: ['t'] },
            { name: 'no command', match: 'x', command: [] },
            'nope',
        ]);
        expect(configs.map((c) => [c.name, c.command, c.batchSize])).toEqual([
            ['tickets', ['/bin/t', '--json'], 20],
            ['big', ['t'], 100],
        ]);
        expect(warnings).toEqual([
            'tsk.linkStatus.connectors[1] (big): "batchSize" is 100.',
            'tsk.linkStatus.connectors[2]: "name" must be a non-empty string.',
            expect.stringMatching(
                /^tsk\.linkStatus\.connectors\[3\] \(bad re\): "match" Invalid regular expression/,
            ),
            'tsk.linkStatus.connectors[4] (no command): "command" must be a non-empty array of strings.',
            'tsk.linkStatus.connectors[5]: not an object.',
        ]);
        expect(parseScriptConnectors(undefined)).toEqual({ configs: [], warnings: [] });
    });
});

describe('readAnswers', () => {
    it('reads one answer a line, for the URLs asked about, and logs the rest', () => {
        const logged: string[] = [];
        const out = [
            '{"url":"u1","label":"Open","category":"open"}',
            '{"url":"u2","error":"no such ticket"}',
            '{"url":"u3","category":"open"}',
            '{"url":"other","label":"x"}',
            'oops',
            '',
        ].join('\n');
        const answers = readAnswers(out, new Set(['u1', 'u2', 'u3']), (l) => logged.push(l));
        expect([...answers]).toEqual([
            ['u1', { label: 'Open', category: 'open' }],
            ['u2', { error: 'no such ticket' }],
            ['u3', { error: 'its answer has no "label"' }],
        ]);
        expect(logged).toEqual([
            `an answer for a URL it wasn't asked about: {"url":"other","label":"x"}`,
            'not JSON: oops',
        ]);
    });
});

describe('scriptConnector', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsk-connector-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    const script = (body: string) => {
        const p = path.join(dir, 'c.sh');
        fs.writeFileSync(p, body);
        return p;
    };
    const run = (body: string, timeoutMs?: number) => {
        const logged: string[] = [];
        const config = {
            name: 't',
            match: /^https:\/\/t\//,
            command: ['sh', script(body)],
            batchSize: 5,
        };
        const c = scriptConnector(config, { log: (l) => logged.push(l), timeoutMs });
        return {
            c,
            logged,
            fetch: (urls: string[]) => c.fetch(urls, new AbortController().signal),
        };
    };

    it('writes the URLs to the program and reads its answers', async () => {
        const { c, fetch, logged } = run(
            'while IFS= read -r url; do printf \'{"url":"%s","label":"Done","category":"done"}\\n\' "$url"; done; echo hi >&2',
        );
        expect(c.matches('https://t/1')).toBe(true);
        expect([...(await fetch(['https://t/1', 'https://t/2']))]).toEqual([
            ['https://t/1', { label: 'Done', category: 'done' }],
            ['https://t/2', { label: 'Done', category: 'done' }],
        ]);
        expect(logged).toEqual(['t: hi']);
    });

    it('runs the program in the folder it is given, so a relative path is from there', async () => {
        const config = {
            name: 'here',
            match: /x/,
            command: [
                'sh',
                '-c',
                'read -r url; printf \'{"url":"%s","label":"%s"}\\n\' "$url" "$(pwd)"',
            ],
            batchSize: 1,
        };
        const c = scriptConnector(config, { cwd: dir, log: () => {} });
        expect(await c.fetch(['x'], new AbortController().signal)).toEqual(
            new Map([['x', { label: fs.realpathSync(dir), category: 'unknown' }]]),
        );
    });

    it("fails the batch with the program's last stderr line when it exits non-zero", async () => {
        await expect(
            run('echo one >&2; echo "no token" >&2; exit 3').fetch(['https://t/1']),
        ).rejects.toThrow('exited 3: no token');
    });

    it("stops a program that doesn't answer in time, and one that can't run", async () => {
        await expect(run('sleep 5', 200).fetch(['https://t/1'])).rejects.toThrow(
            "didn't answer within 0.2 s",
        );
        const missing = scriptConnector(
            { name: 'm', match: /x/, command: [path.join(dir, 'nothing')], batchSize: 1 },
            { log: () => {} },
        );
        await expect(missing.fetch(['x'], new AbortController().signal)).rejects.toThrow(
            /^can't run .*nothing: /,
        );
    });
});
