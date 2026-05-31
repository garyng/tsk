import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';

/**
 * Demo regression guard (M24/D). `docs/demo.tsk` is a tutorial built around
 * keystrokes; this test makes sure it never references a keybinding we've
 * since renamed or removed. It reads the real demo from the extension's
 * `docs/`, scans the `Alt+<key>` chords it mentions, and asserts each is a
 * contributed keybinding whose command is actually registered. The three
 * list-edit keys (Enter / Tab / Shift+Tab) are checked explicitly since the
 * demo documents them by name.
 */
suite('demo.tsk smoke (M24)', () => {
    let demoText: string;
    let keyToCommand: Map<string, string>;
    let registered: ReadonlyArray<string>;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();

        demoText = readFileSync(join(ext.extensionPath, 'docs', 'demo.tsk'), 'utf8');

        const keybindings = ext.packageJSON.contributes.keybindings as ReadonlyArray<{
            key: string;
            command: string;
        }>;
        keyToCommand = new Map(keybindings.map((kb) => [kb.key.toLowerCase(), kb.command]));

        registered = await vscode.commands.getCommands(true);
    });

    test('every Alt+<key> the demo mentions is a registered keybinding', () => {
        // Single-char Alt chords. The (?![A-Za-z]) guard means a prose word
        // like "Alt+backtick" is NOT misread as the chord "Alt+b" — only a
        // genuine one-character chord (followed by a non-letter) matches. The
        // backtick is in the class so the `Alt+`` copy-id chord is covered.
        const found = new Set<string>();
        for (const m of demoText.matchAll(/Alt\+([A-Za-z0-9`])(?![A-Za-z])/g)) {
            const ch = m[1];
            if (ch) found.add(`alt+${ch.toLowerCase()}`);
        }

        // Sanity: the tutorial covers the bulk of the Alt surface. If this
        // collapses, the scan (or the demo) regressed.
        assert.ok(found.size >= 10, `expected to scan many Alt chords, found ${found.size}`);

        for (const key of found) {
            const command = keyToCommand.get(key);
            assert.ok(
                command,
                `demo mentions ${key}, but no keybinding binds it (renamed / removed?)`,
            );
            assert.ok(
                registered.includes(command),
                `${key} → ${command} is referenced by the demo but not registered`,
            );
        }
    });

    test('the list-edit keys the demo documents (Enter / Tab / Shift+Tab) are registered', () => {
        const cases: ReadonlyArray<[key: string, label: string]> = [
            ['enter', 'Enter'],
            ['tab', 'Tab'],
            ['shift+tab', 'Shift+Tab'],
        ];
        for (const [key, label] of cases) {
            assert.ok(demoText.includes(label), `demo should still document ${label}`);
            const command = keyToCommand.get(key);
            assert.ok(command, `expected a keybinding for ${key}`);
            assert.ok(registered.includes(command), `${key} → ${command} is not registered`);
        }
    });
});
