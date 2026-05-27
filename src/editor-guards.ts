import * as vscode from 'vscode';
import { TSK_LANGUAGE_ID } from './constants';
import type { Logger } from './lib/logger';

/**
 * Predicate: does this document belong to the tsk language? Pulled out
 * so the language-id literal lives in one place and call sites read as
 * an intention (`isTskDocument(...)`) rather than a string comparison.
 *
 * Side-effect-free — safe to call anywhere, including from hot paths.
 */
export function isTskDocument(doc: vscode.TextDocument): boolean {
    return doc.languageId === TSK_LANGUAGE_ID;
}

/**
 * Fetch the active text editor, but only if it's editing a `.tsk` file.
 * On miss (no active editor, or wrong language), logs a debug line
 * keyed by `commandId` and returns `undefined`. Callers do
 *
 *   const editor = requireTskEditor(logger, COMMANDS.something);
 *   if (!editor) return;
 *
 * The two failure paths log distinct messages so a `debug`-level trace
 * can disambiguate "no editor" vs. "wrong language" without extra
 * caller code.
 */
export function requireTskEditor(logger: Logger, commandId: string): vscode.TextEditor | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        logger.debug(`${commandId}: no active editor`);
        return undefined;
    }
    if (!isTskDocument(editor.document)) {
        logger.debug(`${commandId}: skipped — language id is "${editor.document.languageId}"`);
        return undefined;
    }
    return editor;
}
