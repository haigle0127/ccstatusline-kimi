import * as vscode from 'vscode';

const SECTION = 'ccstatusline';

export interface CcstatuslineConfig {
    enabled: boolean;
    refreshInterval: number;
    format: string;
    statusFilePath: string;
    showWhenIdle: boolean;
    hideAfterMs: number;
}

export function getConfig(): CcstatuslineConfig {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    return {
        enabled: cfg.get<boolean>('enabled', true),
        refreshInterval: cfg.get<number>('refreshInterval', 2000),
        format: cfg.get<string>('format', '$(comment-discussion) {model} | {git-branch} | {tokens-input} {tokens-output} | {cost} | 已用{context-length}'),
        statusFilePath: cfg.get<string>('statusFilePath', ''),
        showWhenIdle: cfg.get<boolean>('showWhenIdle', true),
        hideAfterMs: cfg.get<number>('hideAfterMs', 0)
    };
}

export function onConfigChange(handler: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(SECTION)) {
            handler();
        }
    });
}
