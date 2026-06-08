import * as vscode from 'vscode';
import { StatusBarManager } from './statusBar';
import { HistoryPanel } from './historyPanel';

let manager: StatusBarManager | null = null;

export function activate(context: vscode.ExtensionContext): void {
    manager = new StatusBarManager();

    context.subscriptions.push(
        vscode.commands.registerCommand('ccstatusline.refresh', () => {
            void manager?.refresh();
        }),
        vscode.commands.registerCommand('ccstatusline.showHistory', () => {
            HistoryPanel.createOrShow();
        }),
        vscode.commands.registerCommand('ccstatusline.openSettings', () => {
            void vscode.commands.executeCommand(
                'workbench.action.openSettings',
                '@ext:ccstatusline-vscode ccstatusline'
            );
        }),
        vscode.commands.registerCommand('ccstatusline.copyStatusJson', () => {
            manager?.copyStatusJson();
        }),
        manager
    );
}

export function deactivate(): void {
    manager?.dispose();
    manager = null;
}
