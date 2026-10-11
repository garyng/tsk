import { spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';

/**
 * Benchmarks the ways tsk could enumerate its files, inside a REAL VS Code
 * against a real workspace. Run it with `task bench:file-search`.
 *
 * It exists because reload-and-read-the-log produced three wrong conclusions
 * in one afternoon: single measurements during extension-host startup are too
 * noisy to attribute, and `findFiles` readings for the same build ranged
 * 785ms–2940ms. This runs every candidate N times in one process and reports
 * the first call separately from the steady state — activation pays the cold
 * one, the completion provider pays the warm one.
 */

const ITERATIONS = 5;
const OUT = process.env.TSK_BENCH_OUT;

interface Timing {
    label: string;
    first: number;
    warm: number[];
    count: number;
}

const root = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

async function time(label: string, run: () => Promise<number>, results: Timing[]): Promise<void> {
    const samples: number[] = [];
    let count = 0;
    for (let i = 0; i <= ITERATIONS; i++) {
        const started = Date.now();
        count = await run();
        samples.push(Date.now() - started);
    }
    results.push({
        label,
        first: samples[0] as number,
        warm: samples.slice(1),
        count,
    });
}

/** `git ls-files -z <args>`, paths relative to `cwd`. */
function lsFiles(cwd: string, args: readonly string[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['ls-files', '-z', ...args], { cwd });
        let stdout = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.on('error', reject);
        child.on('close', () => resolve(stdout.split('\0').filter((l) => l !== '')));
    });
}

/** A plain recursive `node:fs` walk, skipping the same directories. */
async function walk(dir: string, skip: ReadonlySet<string>, out: string[]): Promise<void> {
    let entries: Dirent[];
    try {
        entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
        return;
    }
    for (const entry of entries) {
        // `Dirent.isDirectory()` is false for a symlink, so symlinked
        // directories (a venv's `lib64 -> lib`) are never followed.
        if (entry.isDirectory()) {
            if (skip.has(entry.name)) continue;
            await walk(join(dir, entry.name), skip, out);
        } else if (entry.name.endsWith('.tsk')) {
            out.push(join(dir, entry.name));
        }
    }
}

suite('file-search benchmark', () => {
    test(`enumerate .tsk files, ${ITERATIONS + 1} runs each`, async () => {
        const ext = vscode.extensions.getExtension('garyng.tsk');
        await ext?.activate();
        const cwd = root();
        const results: Timing[] = [];

        await time(
            'findFiles(**/*.tsk, {node_modules,.git})',
            async () =>
                (await vscode.workspace.findFiles('**/*.tsk', '{**/node_modules/**,**/.git/**}'))
                    .length,
            results,
        );

        await time(
            'findFiles(**/*.tsk, node_modules only)',
            async () => (await vscode.workspace.findFiles('**/*.tsk', '**/node_modules/**')).length,
            results,
        );

        await time(
            'findFiles(**/*.tsk, undefined exclude)',
            async () => (await vscode.workspace.findFiles('**/*.tsk', undefined)).length,
            results,
        );

        await time(
            'findFiles(**/*.{md,tsk}, {node_modules,.git})  [picker]',
            async () =>
                (
                    await vscode.workspace.findFiles(
                        '**/*.{md,tsk}',
                        '{**/node_modules/**,**/.git/**}',
                        5000,
                    )
                ).length,
            results,
        );

        await time(
            'git ls-files x2, filtered to .tsk',
            async () => {
                const [own, subs] = await Promise.all([
                    lsFiles(cwd, ['--cached', '--others', '--exclude-standard']),
                    lsFiles(cwd, ['--cached', '--recurse-submodules']),
                ]);
                return new Set([...own, ...subs].filter((p) => p.endsWith('.tsk'))).size;
            },
            results,
        );

        await time(
            'git ls-files x2, full allowlist (no filter)',
            async () => {
                const [own, subs] = await Promise.all([
                    lsFiles(cwd, ['--cached', '--others', '--exclude-standard']),
                    lsFiles(cwd, ['--cached', '--recurse-submodules']),
                ]);
                return new Set([...own, ...subs]).size;
            },
            results,
        );

        await time(
            'node:fs recursive walk',
            async () => {
                const out: string[] = [];
                await walk(cwd, new Set(['node_modules', '.git']), out);
                return out.length;
            },
            results,
        );

        const median = (xs: readonly number[]): number =>
            [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
        const lines = [
            `workspace: ${cwd}`,
            `iterations: 1 cold + ${ITERATIONS} warm`,
            '',
            `${'candidate'.padEnd(52)} ${'cold'.padStart(7)} ${'warm med'.padStart(9)} ${'warm min'.padStart(9)} ${'warm max'.padStart(9)}  files`,
            ''.padEnd(100, '-'),
            ...results.map(
                (r) =>
                    `${r.label.padEnd(52)} ${`${r.first}ms`.padStart(7)} ${`${median(r.warm)}ms`.padStart(9)} ` +
                    `${`${Math.min(...r.warm)}ms`.padStart(9)} ${`${Math.max(...r.warm)}ms`.padStart(9)}  ${r.count}`,
            ),
        ];
        const report = lines.join('\n');
        if (OUT) writeFileSync(OUT, `${report}\n`);
        console.log(report);
    });
});
