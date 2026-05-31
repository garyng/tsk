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
 * Predicate: is this document suitable for cache writes? True when the
 * document survives across sessions (i.e. is backed by a real file on
 * disk). False for untitled buffers — those participate in live features
 * (decorations, completion, toggles, Enter/Tab) but their tasks
 * never reach the SQLite cache. See M18 for the local-only scope.
 *
 * Distinct from {@link isTskDocument}: that one gates on language id;
 * this one gates on persistability. Cache writes need both checks.
 */
export function isPersistableDocument(doc: vscode.TextDocument): boolean {
    return !doc.isUntitled;
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
