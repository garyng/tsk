import { statfsSync } from 'node:fs';

// Some bind mounts deliver NO inotify events — notably a Windows drive shared into Linux over 9p
// (WSL2, Docker Desktop) — so a default `--watch` (Rollup → chokidar) never sees edits and the
// watch silently does nothing. Poll only there: on a native disk, real events are cheaper and
// instant. CHOKIDAR_USEPOLLING=1/true or 0/false overrides the detection (e.g. for NFS/CIFS).
const V9FS_MAGIC = 0x01021997;

export function watchPolling(dir: string): boolean {
    const env = process.env.CHOKIDAR_USEPOLLING?.toLowerCase();
    if (env === '1' || env === 'true') return true;
    if (env === '0' || env === 'false') return false;
    try {
        return statfsSync(dir).type === V9FS_MAGIC;
    } catch {
        return false;
    }
}
