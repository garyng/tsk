import * as assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
    DEFAULT_CLIPBOARD_BRIDGE_ENABLED,
    DEFAULT_CLIPBOARD_BRIDGE_PATH,
} from '../../src/constants';

const EXTENSION_ID = 'garyng.tsk';
const ENABLED_KEY = 'clipboard.bridgeEnabled';
const PATH_KEY = 'clipboard.bridgePath';

/**
 * Clipboard-bridge e2e (M22). Drives the full mechanism inside the test
 * host: enable the bridge pointed at a temp file, write the file, and
 * assert the host clipboard (the test VS Code instance's clipboard)
 * receives the contents.
 *
 * The bridge is config-driven, so this test mutates workspace settings.
 * It restores them (and deletes the temp file) in `finally`. A generous
 * per-test timeout absorbs the devcontainer's slow config-change →
 * `onDidChangeConfiguration` → `fs.watch` propagation.
 */
suite('clipboard bridge', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
    });

    test('writing the watch file copies its contents to the clipboard', async function () {
        this.timeout(60000);
        const config = () => vscode.workspace.getConfiguration('tsk');
        const tmpDir = mkdtempSync(join(tmpdir(), 'tsk-bridge-e2e-'));
        const watchFile = join(tmpDir, 'clip.txt');
        const sentinel = `bridge-sentinel-${Date.now()}`;

        try {
            // Point the bridge at the temp file and enable it. Each update
            // fires onDidChangeConfiguration → reconcile(); the second one
            // (enabled=true) starts the watcher.
            await config().update(PATH_KEY, watchFile, vscode.ConfigurationTarget.Workspace);
            await config().update(ENABLED_KEY, true, vscode.ConfigurationTarget.Workspace);
            // Give the listener + fs.watch attach a beat to settle.
            await new Promise((resolve) => setTimeout(resolve, 300));

            writeFileSync(watchFile, sentinel, 'utf8');

            // Poll the clipboard until the bridge pushes our sentinel (or
            // we give up). Bridge debounce is 50ms; allow generous slack.
            let got = '';
            for (let i = 0; i < 60; i++) {
                got = await vscode.env.clipboard.readText();
                if (got === sentinel) break;
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            assert.strictEqual(got, sentinel, 'clipboard should hold the watch-file contents');
        } finally {
            // Disable BEFORE clearing the path. If the path reverts first
            // while the bridge is still enabled, reconcile() falls back to
            // the DEFAULT path (${workspaceFolder}/.vscode/tsk-clipboard.txt)
            // and touches it inside the fixture — a stray artifact.
            await config().update(ENABLED_KEY, undefined, vscode.ConfigurationTarget.Workspace);
            await config().update(PATH_KEY, undefined, vscode.ConfigurationTarget.Workspace);
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('the bridge stays inactive (no clipboard write) when disabled', async function () {
        this.timeout(60000);
        const config = () => vscode.workspace.getConfiguration('tsk');
        const tmpDir = mkdtempSync(join(tmpdir(), 'tsk-bridge-e2e-'));
        const watchFile = join(tmpDir, 'clip.txt');
        const marker = `should-not-appear-${Date.now()}`;

        try {
            // Seed the clipboard with a known value, leave the bridge OFF,
            // point its (unused) path at the temp file, then write the file.
            await vscode.env.clipboard.writeText('baseline');
            await config().update(PATH_KEY, watchFile, vscode.ConfigurationTarget.Workspace);
            await config().update(ENABLED_KEY, false, vscode.ConfigurationTarget.Workspace);
            await new Promise((resolve) => setTimeout(resolve, 300));

            writeFileSync(watchFile, marker, 'utf8');
            await new Promise((resolve) => setTimeout(resolve, 500));

            const got = await vscode.env.clipboard.readText();
            assert.strictEqual(got, 'baseline', 'disabled bridge must not touch the clipboard');
        } finally {
            // Disable before clearing the path (see note in the test above).
            await config().update(ENABLED_KEY, undefined, vscode.ConfigurationTarget.Workspace);
            await config().update(PATH_KEY, undefined, vscode.ConfigurationTarget.Workspace);
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('contributes.configuration declares both clipboard-bridge settings', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const props = ext.packageJSON.contributes.configuration.properties as Record<
            string,
            { type: string; default: unknown }
        >;
        assert.strictEqual(props['tsk.clipboard.bridgeEnabled']?.type, 'boolean');
        assert.strictEqual(props['tsk.clipboard.bridgeEnabled']?.default, false);
        assert.strictEqual(props['tsk.clipboard.bridgePath']?.type, 'string');
        assert.strictEqual(
            props['tsk.clipboard.bridgePath']?.default,
            '${workspaceFolder}/.vscode/tsk/clipboard-bridge.txt',
        );
    });

    test('package.json defaults match the mirrored DEFAULT_* constants (drift guard)', () => {
        // The code keeps DEFAULT_* constants mirroring the manifest defaults
        // (used as the .get() fallback). Assert they stay in sync so the two
        // sources of truth can't silently drift.
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        const props = ext.packageJSON.contributes.configuration.properties as Record<
            string,
            { default: unknown }
        >;
        assert.strictEqual(
            props['tsk.clipboard.bridgePath']?.default,
            DEFAULT_CLIPBOARD_BRIDGE_PATH,
        );
        assert.strictEqual(
            props['tsk.clipboard.bridgeEnabled']?.default,
            DEFAULT_CLIPBOARD_BRIDGE_ENABLED,
        );
    });
});
