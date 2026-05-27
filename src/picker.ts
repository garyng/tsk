import * as vscode from 'vscode';
import type { CacheService } from './lib/cache';
import { sanitizeClipboardForId, type TaskPickItem, taskToPickItem } from './lib/picker-logic';

export interface PickTaskIdOpts {
    /** Visible prompt / placeholder string (e.g. "Pick the related task"). */
    prompt: string;
    /** Cache to enumerate when the user switches to "Browse tasks…". */
    cache: CacheService;
    /**
     * When true, accepting an empty InputBox resolves to `''` (the
     * sentinel for "explicitly no target") instead of `undefined`. Escape
     * / hide still resolves to `undefined`, so callers can distinguish
     * "user wants no target" from "user cancelled". Default false.
     *
     * Used by `toggleMoved` so users can mark a task as moved-elsewhere
     * without picking a specific target task.
     */
    allowEmpty?: boolean;
}

/**
 * Two-mode picker for a task `@id`:
 *
 *   1. **InputBox** (default) — opens prefilled with the clipboard text,
 *      sanitized to its first whitespace-delimited token (`sanitizeClipboardForId`).
 *      Submitting returns the trimmed text.
 *   2. **Browse tasks…** (button) — clicking the button hides the InputBox
 *      and opens a QuickPick of every cached task (`cache.listAllTasks()`
 *      mapped through `taskToPickItem`). Selecting a row returns its `@id`.
 *
 * Returns `undefined` for cancel/escape/dismiss.
 *
 * The vscode-bound shell lives here; the pure shaping/sanitization sits in
 * `lib/picker-logic.ts` so it can be exercised by vitest without a real
 * editor host.
 */
export async function pickTaskId(opts: PickTaskIdOpts): Promise<string | undefined> {
    const prefilled = sanitizeClipboardForId(await vscode.env.clipboard.readText());

    return new Promise<string | undefined>((resolve) => {
        const input = vscode.window.createInputBox();
        input.prompt = opts.prompt;
        input.placeholder = opts.prompt;
        input.value = prefilled;
        const browseButton: vscode.QuickInputButton = {
            iconPath: new vscode.ThemeIcon('search'),
            tooltip: 'Browse tasks…',
        };
        input.buttons = [browseButton];

        let settled = false;
        const settle = (value: string | undefined): void => {
            if (settled) return;
            settled = true;
            input.hide();
            input.dispose();
            resolve(value);
        };

        input.onDidAccept(() => {
            const trimmed = input.value.trim();
            if (trimmed !== '') {
                settle(trimmed);
                return;
            }
            // Empty submission: '' if caller opted into the "no target" path,
            // otherwise treated identically to a cancel.
            settle(opts.allowEmpty ? '' : undefined);
        });
        input.onDidHide(() => settle(undefined));
        input.onDidTriggerButton((button) => {
            if (button !== browseButton) return;
            settled = true;
            input.hide();
            input.dispose();
            // Open the QuickPick fresh; its result resolves the outer Promise.
            pickFromCache(opts).then((picked) => resolve(picked));
        });

        input.show();
    });
}

async function pickFromCache(opts: PickTaskIdOpts): Promise<string | undefined> {
    const items: TaskPickItem[] = opts.cache.listAllTasks().map(taskToPickItem);
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: opts.prompt,
        matchOnDescription: true,
        matchOnDetail: true,
    });
    return picked?.id;
}
