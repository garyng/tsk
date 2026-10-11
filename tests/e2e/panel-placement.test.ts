import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'garyng.tsk';
const STATS_TAB = 'Tsk Stats';

/**
 * `tsk.panel.<panel>.openDirection` e2e. Geometry is observed through
 * `window.tabGroups`, which is as close as the extension API gets to "where did
 * the panel land": the assertion that matters is whether the panel shares the
 * editor's group (`active`) or occupies its own (`below`) — the distinction
 * `ViewColumn` alone cannot express, since there is no `ViewColumn.Below`.
 */
suite('panel open direction', () => {
    const config = () => vscode.workspace.getConfiguration('tsk');

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
        await ext.activate();
    });

    suiteTeardown(async () => {
        for (const key of [
            'panel.nowStack.openDirection',
            'panel.stats.openDirection',
            'panel.taskList.openDirection',
        ]) {
            await config().update(key, undefined, vscode.ConfigurationTarget.Global);
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    /** The group holding the stats panel, or `undefined`. */
    const statsGroup = (): vscode.TabGroup | undefined =>
        vscode.window.tabGroups.all.find((group) =>
            group.tabs.some((tab) => tab.label === STATS_TAB),
        );

    const openStatsWith = async (direction: string): Promise<void> => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await config().update(
            'panel.stats.openDirection',
            direction,
            vscode.ConfigurationTarget.Global,
        );
        const doc = await vscode.workspace.openTextDocument({
            content: '- [ ] placement probe',
            language: 'tsk',
        });
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('tsk.openStats');
        // The panel is created and (for a split direction) moved; give the
        // workbench a tick to settle its groups before reading them.
        for (let attempt = 0; attempt < 20 && statsGroup() === undefined; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    };

    test('"active" puts the panel in the editor’s own group', async () => {
        await openStatsWith('active');
        const group = statsGroup();
        assert.ok(group, 'the stats panel should be open');
        assert.strictEqual(
            vscode.window.tabGroups.all.length,
            1,
            'active placement should not split the editor area',
        );
    });

    test('"below" puts the panel in a group of its own', async () => {
        await openStatsWith('below');
        const group = statsGroup();
        assert.ok(group, 'the stats panel should be open');
        assert.ok(
            vscode.window.tabGroups.all.length >= 2,
            `below placement should split; got ${vscode.window.tabGroups.all.length} group(s)`,
        );
        // Every tab in the panel's group is the panel itself — the probe doc is
        // untitled, so matching on a `.tsk` label could never have failed.
        assert.ok(
            group.tabs.every((tab) => tab.label === STATS_TAB),
            'the panel should not share a group with the editor',
        );
    });

    test('re-opening a panel leaves it where it is', async () => {
        // Regression: Now Stack re-opened with `reveal(ViewColumn.Beside)`,
        // which MOVES an already-open panel next to the active editor — the
        // opposite of "applied on create, never on reveal". `reveal()` with no
        // column shows it in its current group.
        //
        // The layout has to put the panel somewhere that is NOT beside the
        // active editor, or `Beside` resolves to the panel's own group and the
        // bug is invisible: [doc A | Now Stack | doc B], re-opened from doc B.
        const nowColumn = (): vscode.ViewColumn | undefined =>
            vscode.window.tabGroups.all.find((g) => g.tabs.some((t) => t.label === 'Now Stack'))
                ?.viewColumn;
        const settle = async (probe: () => boolean): Promise<void> => {
            for (let i = 0; i < 20 && !probe(); i++) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        };
        const open = async (content: string, column: vscode.ViewColumn) =>
            vscode.window.showTextDocument(
                await vscode.workspace.openTextDocument({ content, language: 'tsk' }),
                column,
            );

        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await open('- [ ] doc A', vscode.ViewColumn.One);
        await vscode.commands.executeCommand('tsk.now.openStack'); // -> column 2 (Beside)
        await settle(() => nowColumn() !== undefined);
        assert.strictEqual(nowColumn(), vscode.ViewColumn.Two, 'precondition: panel beside doc A');

        await open('- [ ] doc B', vscode.ViewColumn.Three); // active; its "beside" is column 4
        await vscode.commands.executeCommand('tsk.now.openStack');
        // A move lands asynchronously, and this asserts that one DOESN'T happen
        // — so there's no event to await. Wait a bounded time for any tab change
        // rather than polling the column, which already reads 2 before a move
        // would have had a chance to land.
        await new Promise<void>((resolve) => {
            const done = (): void => {
                clearTimeout(timer);
                sub.dispose();
                resolve();
            };
            const timer = setTimeout(done, 1500);
            const sub = vscode.window.tabGroups.onDidChangeTabs(() => setTimeout(done, 300));
        });
        assert.strictEqual(
            nowColumn(),
            vscode.ViewColumn.Two,
            're-opening must not move the panel',
        );
    });

    test('an unknown direction still opens the panel', async () => {
        await openStatsWith('sideways');
        assert.ok(statsGroup(), 'a settings typo must not stop a panel from opening');
    });

    test('each panel has its own setting, defaulting to its ORIGINAL placement', () => {
        // The point of per-panel settings rather than one: before the setting
        // existed, Now Stack opened Beside while Stats and Task List opened in
        // the editor's own group. A single key could not default to both.
        assert.strictEqual(
            config().inspect<string>('panel.nowStack.openDirection')?.defaultValue,
            'right',
        );
        assert.strictEqual(
            config().inspect<string>('panel.stats.openDirection')?.defaultValue,
            'active',
        );
        assert.strictEqual(
            config().inspect<string>('panel.taskList.openDirection')?.defaultValue,
            'active',
        );
    });

    test('the panels are configured independently', async () => {
        // Point Stats below and leave Task List at its default: the two should
        // land in different groups.
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await config().update(
            'panel.stats.openDirection',
            'below',
            vscode.ConfigurationTarget.Global,
        );
        const doc = await vscode.workspace.openTextDocument({
            content: '- [ ] independence probe',
            language: 'tsk',
        });
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('tsk.openTaskList');
        await vscode.commands.executeCommand('tsk.openStats');
        for (let attempt = 0; attempt < 20 && statsGroup() === undefined; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const stats = statsGroup();
        const taskList = vscode.window.tabGroups.all.find((group) =>
            group.tabs.some((tab) => tab.label === 'Tsk Task List'),
        );
        assert.ok(stats && taskList, 'both panels should be open');
        assert.notStrictEqual(
            stats.viewColumn,
            taskList.viewColumn,
            'stats below, task list in the editor group — different groups',
        );
    });
});
