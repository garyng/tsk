/** A task's id where the output prints one: after its marker (`[x] `), before its text. */
const TASK_ID = /(\[[^\]]\] )([A-Za-z0-9_-]{1,64})(?= )/g;
/** The terminal's own cyan, so a light or dark scheme picks a shade it can read. */
const CYAN = '\u001B[36m';
const DEFAULT_COLOUR = '\u001B[39m';

/**
 * `text` with each task's id written `tsk:<id>`, in cyan unless `colour` is
 * off: what tmux's Ctrl+Click reads to select the task
 * in the TUI beside the pane (`select-clicked.ts`), standing out as a reply's
 * does. Only for a terminal; what Claude reads stays plain. No `vscode://`
 * link: Windows Terminal would open it too, bringing
 * VS Code to the front.
 */
export function idsAsRefs(text: string, colour: boolean): string {
    const [on, off] = colour ? [CYAN, DEFAULT_COLOUR] : ['', ''];
    return text.replace(
        TASK_ID,
        (_all, marker: string, id: string) => `${marker}${on}tsk:${id}${off}`,
    );
}
