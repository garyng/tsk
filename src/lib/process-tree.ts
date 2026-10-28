import fs from 'node:fs';

/** `root` and every process under it, from each process's parent. */
export function descendants(root: number, parentOf: ReadonlyMap<number, number>): Set<number> {
    const children = new Map<number, number[]>();
    for (const [pid, parent] of parentOf)
        children.set(parent, [...(children.get(parent) ?? []), pid]);
    const found = new Set<number>([root]);
    const queue = [root];
    for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
        for (const child of children.get(pid) ?? []) {
            if (found.has(child)) continue;
            found.add(child);
            queue.push(child);
        }
    }
    return found;
}

/** `root` and every process under it now, read from `/proc`; just `root` where there's none. */
export function processTree(root: number): Set<number> {
    const parentOf = new Map<number, number>();
    let pids: string[];
    try {
        pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
    } catch {
        return new Set([root]);
    }
    for (const pid of pids) {
        try {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
            // Field 4, counted from the last ')': the command name can hold anything.
            const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
            parentOf.set(Number(pid), parent);
        } catch {
            // Gone since the listing.
        }
    }
    return descendants(root, parentOf);
}
