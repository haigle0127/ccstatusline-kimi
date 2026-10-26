import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { collectClaudeState, getClaudeConfigDir } from './claude';
import { CCSWITCH_DB_PATH, CCSWITCH_SETTINGS_PATH } from './sqlite';
import { getGitInfo } from './git';
import { getConfig, onConfigChange, type CcstatuslineConfig } from './config';
import { renderFormat } from './widgets';
import type { ClaudeState, RenderContext } from './types';


export class StatusBarManager {
    private item: vscode.StatusBarItem;
    private timer: NodeJS.Timeout | null = null;
    private debounceTimer: NodeJS.Timeout | null = null;
    private watchers: fs.FSWatcher[] = [];
    private config: CcstatuslineConfig;
    private disposables: vscode.Disposable[] = [];
    private lastState: ClaudeState | null = null;
    private lastTranscriptPath: string | null = null;
    private refreshVersion = 0;

    constructor() {
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            1000 // priority: higher appears further right
        );
        this.config = getConfig();
        this.item.command = 'ccstatusline.showHistory';
        this.item.show();

        this.disposables.push(this.item);
        this.disposables.push(onConfigChange(() => this.onConfigChanged()));
        this.disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh())
        );
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.refresh())
        );

        this.startPolling();
        this.setupWatchers();
        this.refresh();
    }

    private getWorkspaceFolder(): string | undefined {
        const editor = vscode.window.activeTextEditor;
        if (editor?.document?.uri) {
            const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
            if (folder) {
                return folder.uri.fsPath;
            }
        }

        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            return folders[0].uri.fsPath;
        }

        return undefined;
    }

    private onConfigChanged(): void {
        this.config = getConfig();
        this.startPolling();
        this.setupWatchers();
        this.refresh();
    }

    private scheduleRefresh(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.refresh();
        }, 300);
    }

    private watchPath(targetPath: string, recursive = false): void {
        try {
            if (!fs.existsSync(targetPath)) {
                return;
            }
            const watcher = fs.watch(targetPath, { recursive }, (_eventType, filename) => {
                if (filename && filename.endsWith('.jsonl')) {
                    this.scheduleRefresh();
                } else if (filename && (filename.endsWith('.json') || filename === 'settings.json' || filename === 'cc-switch.db')) {
                    this.scheduleRefresh();
                } else {
                    this.scheduleRefresh();
                }
            });
            this.watchers.push(watcher);
        } catch {
            // ignore watch failures
        }
    }

    private setupWatchers(): void {
        // clear existing watchers
        for (const w of this.watchers) {
            try { w.close(); } catch { /* ignore */ }
        }
        this.watchers = [];
        this.lastTranscriptPath = null;

        if (!this.config.enabled) {
            return;
        }

        const claudeDir = getClaudeConfigDir();

        // Watch sessions directory for new/removed active sessions
        this.watchPath(path.join(claudeDir, 'sessions'), false);

        // Watch projects directory for new transcripts
        this.watchPath(path.join(claudeDir, 'projects'), true);

        // Watch Claude settings for model changes
        this.watchPath(path.join(claudeDir, 'settings.json'), false);

        // Watch cc-switch database and settings for provider/directory changes
        this.watchPath(CCSWITCH_DB_PATH, false);
        this.watchPath(CCSWITCH_SETTINGS_PATH, false);

        // Also watch the currently active transcript if known
        this.updateTranscriptWatcher();
    }

    private updateTranscriptWatcher(): void {
        const transcriptPath = this.lastState?.transcriptPath;
        if (!transcriptPath) {
            return;
        }

        if (fs.existsSync(transcriptPath) && transcriptPath !== this.lastTranscriptPath) {
            this.lastTranscriptPath = transcriptPath;
            this.watchPath(transcriptPath, false);
        }
    }

    private startPolling(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }

        if (!this.config.enabled) {
            this.item.hide();
            return;
        }

        this.item.show();
        this.timer = setInterval(() => this.refresh(), this.config.refreshInterval);
    }

    async refresh(): Promise<void> {
        const version = ++this.refreshVersion;
        if (!this.config.enabled) {
            this.item.hide();
            return;
        }

        const workspaceFolder = this.getWorkspaceFolder();

        try {
            const [state, gitInfo] = await Promise.all([
                collectClaudeState(workspaceFolder),
                getGitInfo(workspaceFolder)
            ]);

            if (version !== this.refreshVersion) {
                return;
            }
            state.gitInfo = gitInfo;
            this.lastState = state;

            // Ensure we are watching the active transcript file
            this.updateTranscriptWatcher();

            const isIdle = !state.session;
            if (isIdle && !this.config.showWhenIdle) {
                this.item.hide();
                return;
            }

            if (this.config.hideAfterMs > 0 && state.activityAt > 0 &&
                Date.now() - state.activityAt > this.config.hideAfterMs) {
                this.item.hide();
                return;
            }

            this.item.show();

            const ctx: RenderContext = { state, workspaceFolder };
            const rendered = renderFormat(this.config.format, ctx);

            this.item.text = rendered.text || '$(comment-discussion) Claude';
            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(rendered.tooltip.replace(/\n/g, '\n\n'));
            tooltip.appendMarkdown('\n\n---\n\n[$(gear) 打开设置](command:ccstatusline.openSettings)');
            tooltip.isTrusted = true;
            this.item.tooltip = tooltip;
            this.item.color = undefined;
        } catch (error) {
            this.item.text = '$(claude) ...';
            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`状态更新失败: ${error instanceof Error ? error.message : String(error)}`);
            tooltip.appendMarkdown('\n\n---\n\n[$(gear) 打开设置](command:ccstatusline.openSettings)');
            tooltip.isTrusted = true;
            this.item.tooltip = tooltip;
        }
    }

    copyStatusJson(): void {
        if (!this.lastState) {
            void vscode.window.showInformationMessage('暂无 Claude 状态数据');
            return;
        }
        const json = JSON.stringify(this.lastState, null, 2);
        void vscode.env.clipboard.writeText(json);
        void vscode.window.showInformationMessage('Claude 状态 JSON 已复制到剪贴板');
    }

    dispose(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        for (const w of this.watchers) {
            try { w.close(); } catch { /* ignore */ }
        }
        this.watchers = [];
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }
}
