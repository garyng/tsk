import fs from 'node:fs';

/**
 * Field 22 of `/proc/<pid>/stat`: the process's start time in clock ticks
 * since boot, or undefined when there's no such process (or no `/proc`).
 * With the pid, it names one process: a pid can be reused, a start can't.
 */
export function processStart(pid: number): string | undefined {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        // The command name (field 2) can hold spaces and parentheses; count from the last ')'.
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    } catch {
        return undefined;
    }
}
