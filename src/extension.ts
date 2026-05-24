import * as vscode from 'vscode';
import { Logger, type LogLevel } from './lib/logger';

let logger: Logger | undefined;

export function activate(context: vscode.ExtensionContext): void {
    const channel = vscode.window.createOutputChannel('tsk');
    logger = new Logger(channel, readLogLevel());
    context.subscriptions.push(channel);

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('tsk.log.level')) {
                logger?.setLevel(readLogLevel());
                logger?.info(`log level changed to ${readLogLevel()}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tsk.rebuildCache', () => {
            logger?.info('tsk.rebuildCache invoked (stub — real implementation lands in M3).');
            void vscode.window.showInformationMessage('Tsk: Rebuild Cache (stub)');
        }),
    );

    logger.info('tsk extension activated.');
}

export function deactivate(): void {
    logger?.info('tsk extension deactivated.');
    logger = undefined;
}

function readLogLevel(): LogLevel {
    const value = vscode.workspace.getConfiguration('tsk').get<string>('log.level', 'info');
    if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
        return value;
    }
    return 'info';
}
