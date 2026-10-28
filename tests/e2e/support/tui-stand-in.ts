import fs from 'node:fs';
import { tmuxOf } from '../../../src/lib/tui-channel';
import { listenForRequests } from '../../../src/tui/listen';

/**
 * A stand-in `tsk tui` for the e2e: listens as one does, for the `.tsk` file
 * in argv[2], and writes `listening`, then each id it's asked to select, to
 * the log in argv[3]. Run in a VS Code terminal, plain or in tmux.
 */
const [file, log] = process.argv.slice(2);
const dir = process.env.TSK_RUNTIME_DIR;
if (!file || !log || !dir)
    throw new Error('usage: TSK_RUNTIME_DIR=<dir> tui-stand-in <file> <log>');
const write = (line: string) => fs.appendFileSync(log, `${line}\n`);
listenForRequests({
    dir,
    shows: { file: fs.realpathSync(file), tmux: tmuxOf(process.env) },
    onSelect: (id) => {
        write(id);
        return { ok: true };
    },
    onError: (e) => write(`error ${e.message}`),
}).then(
    () => write('listening'),
    (e: Error) => write(`error ${e.message}`),
);
// Until the terminal, or the tmux server, goes.
setInterval(() => {}, 60_000);
