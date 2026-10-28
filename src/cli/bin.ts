import { main } from './main';

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
}

// The entry point the CLI bundle runs; `main` itself stays free of process globals for tests.
void main({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    readStdin,
    terminal: process.stdout.isTTY === true,
}).then((code) => {
    process.exitCode = code;
});
