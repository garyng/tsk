import * as vscode from 'vscode';
import { isTskDocument } from './editor-guards';
import type { CacheService } from './lib/cache';
import { parseLine } from './lib/parser';

/** A resolved now-task location. */
export interface NowTarget {
    uri: vscode.Uri;
    line: number;
}

/**
 * Resolve a task `@id` to its `(uri, line)` — the SINGLE resolver shared by the
 * now-highlight (`now-decoration`) and the now-jump (`now-tree-commands`), so
 * the two can never disagree about where a now-task is. Cache-first (the
 * canonical occurrence); on a miss, scan the visible `.tsk` editors — covering a
 * just-marked, untitled, or saved-but-not-yet-rescanned task whose live line the
 * cache doesn't hold yet. (Previously these scans were two copies with divergent
 * scopes — untitled-only for jump, all-visible for the highlight — so a jump and
 * its highlight could land on different lines.)
 */
export function resolveNowTarget(cache: CacheService, id: string): NowTarget | undefined {
    const record = cache.lookupById(id);
    if (record) return { uri: vscode.Uri.parse(record.fileUri), line: record.line };

    for (const editor of vscode.window.visibleTextEditors) {
        const doc = editor.document;
        if (!isTskDocument(doc)) continue;
        for (let line = 0; line < doc.lineCount; line++) {
            if (parseLine(doc.lineAt(line).text)?.metadata.get('id') === id) {
                return { uri: doc.uri, line };
            }
        }
    }
    return undefined;
}
