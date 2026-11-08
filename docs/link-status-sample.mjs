#!/usr/bin/env node
// A sample `tsk.linkStatus.connectors` program (README, "Link status"): tsk writes URLs to its
// stdin, one per line, and it answers each with one JSON line, a made-up status picked by the
// number at the URL's end. A connector of your own asks its service instead.
import { createInterface } from 'node:readline';

const STATES = [
    { label: 'Closed', category: 'closed' },
    { label: 'Open', category: 'open' },
    { label: 'In review', category: 'inProgress', checks: 'pending' },
    { label: 'Done', category: 'done', checks: 'passing' },
];

for await (const url of createInterface({ input: process.stdin })) {
    const n = Number(/(\d+)\/?$/.exec(url)?.[1]);
    const answer = Number.isInteger(n)
        ? { url, ...STATES[n % STATES.length], title: `Sample ticket ${n}` }
        : { url, error: 'no number at the end of the URL' };
    console.log(JSON.stringify(answer));
}
