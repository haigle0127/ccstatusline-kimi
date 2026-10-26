import * as vscode from 'vscode';
import { getDateRangePreset, getModelPricing, getUsageDashboard } from './ccswitchDb';

const PRESETS = new Set(['today', 'yesterday', '7d', 'week', '30d', 'month']);

export class HistoryPanel {
    private static currentPanel: HistoryPanel | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private currentPreset: string;
    private refreshVersion = 0;

    public static createOrShow(context: vscode.ExtensionContext): void {
        if (HistoryPanel.currentPanel) {
            HistoryPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
            void HistoryPanel.currentPanel.refreshData();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'ccstatusline.history',
            'Claude Code 用量',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
            }
        );
        HistoryPanel.currentPanel = new HistoryPanel(panel, context);
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext
    ) {
        this.currentPreset = context.globalState.get<string>('ccstatusline.historyPreset', 'today');
        if (!PRESETS.has(this.currentPreset)) {
            this.currentPreset = 'today';
        }

        const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'history.js'));
        const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'history.css'));
        panel.webview.html = this.getHtml(scriptUri, styleUri);
        panel.onDidDispose(() => this.dispose(), null, this.disposables);
        panel.onDidChangeViewState(event => {
            if (event.webviewPanel.visible) {
                void this.refreshData();
            }
        }, null, this.disposables);
        panel.webview.onDidReceiveMessage(message => {
            if (!message || typeof message !== 'object') {
                return;
            }
            switch (message.command) {
                case 'ready':
                case 'refresh':
                    void this.refreshData();
                    return;
                case 'changePreset':
                    if (PRESETS.has(message.preset)) {
                        this.currentPreset = message.preset;
                        void context.globalState.update('ccstatusline.historyPreset', this.currentPreset);
                        void this.refreshData();
                    }
                    return;
                case 'openSettings':
                    void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:haigle.ccstatusline-kimi ccstatusline');
                    return;
            }
        }, null, this.disposables);
    }

    private async refreshData(): Promise<void> {
        const version = ++this.refreshVersion;
        await this.panel.webview.postMessage({ command: 'loading' });
        try {
            await getModelPricing(true);
            const data = await getUsageDashboard(getDateRangePreset(this.currentPreset));
            if (version !== this.refreshVersion) {
                return;
            }
            await this.panel.webview.postMessage({ command: 'setData', data, preset: this.currentPreset });
        } catch (error) {
            if (version !== this.refreshVersion) {
                return;
            }
            await this.panel.webview.postMessage({
                command: 'error',
                message: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private getHtml(scriptUri: vscode.Uri, styleUri: vscode.Uri): string {
        const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
        const csp = `default-src 'none'; style-src ${this.panel.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${this.panel.webview.cspSource} data:; font-src ${this.panel.webview.cspSource}`;
        return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>Claude Code 用量</title>
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div class="app-shell">
        <header class="page-header">
            <div class="brand">
                <span class="brand-mark" aria-hidden="true">✦</span>
                <div><h1>Claude Code 用量</h1><p>本地读取，让每一份消耗都有据可查</p></div>
            </div>
            <button class="icon-button" id="refreshBtn" type="button" title="刷新数据" aria-label="刷新数据">↻</button>
        </header>
        <main class="container">
            <section class="toolbar" aria-label="统计筛选">
                <label class="range-control">时间范围
                    <select id="presetSelect">
                        <option value="today">今日</option>
                        <option value="yesterday">昨日</option>
                        <option value="7d">近 7 天</option>
                        <option value="week">本周</option>
                        <option value="30d">近 30 天</option>
                        <option value="month">本月</option>
                    </select>
                </label>
                <div class="source-meta"><span class="source-dot" aria-hidden="true"></span><span id="sourceLabel">正在读取本地数据</span><span class="meta-separator">·</span><span id="updatedAt"></span></div>
            </section>
            <div id="errorBanner" class="error-banner" role="alert" hidden></div>
            <div id="content" class="content" aria-busy="true">
                <section class="pet-card" id="petCard">
                    <button class="pet-canvas" id="petCanvas" type="button" aria-label="和 Claude 小章鱼互动" title="点我一下">
                        <span class="pet-heart" id="petHeart">♥</span><span class="pet-body" id="petBody"><i class="pet-eye left"></i><i class="pet-eye right"></i><i class="pet-mouth"></i></span>
                        <span class="pet-tentacle t1"></span><span class="pet-tentacle t2"></span><span class="pet-tentacle t3"></span><span class="pet-tentacle t4"></span>
                    </button>
                    <div class="pet-copy"><strong>Claude 小章鱼</strong><span id="petStatus">等你一起写代码</span></div>
                    <div class="pet-level"><span>今日活力</span><strong id="petEnergy">—</strong><div class="pet-meter"><i id="petEnergyFill"></i></div></div>
                </section>
                <section class="card metrics-card" aria-label="核心指标">
                    <div class="metrics-grid">
                        <button class="metric selected" data-metric="tokens" aria-pressed="true"><span>总 Tokens</span><strong id="metricTokens">—</strong><small id="metricTokensSub">新增输入 + 输出 + 缓存</small></button>
                        <button class="metric" data-metric="cost" aria-pressed="false"><span>估算成本</span><strong id="metricCost">—</strong><small id="metricCostSub">按 CC Switch 定价</small></button>
                        <button class="metric" data-metric="requests" aria-pressed="false"><span>请求数</span><strong id="metricRequests">—</strong><small id="metricSuccess">去重后的模型响应</small></button>
                        <button class="metric" data-metric="hitRate" aria-pressed="false"><span>缓存命中率</span><strong id="metricHitRate">—</strong><small>缓存读取 ÷ 可缓存输入</small></button>
                    </div>
                </section>

                <div class="primary-grid">
                    <section class="card chart-card" aria-labelledby="trendTitle">
                        <div class="card-heading"><div><h2 id="trendTitle">Token 趋势</h2><p id="trendSubtitle">按日统计</p></div><span class="chart-unit" id="chartUnit">tokens</span></div>
                        <div class="chart-wrap" id="chartWrap">
                            <svg id="trendChart" viewBox="0 0 720 250" role="img" aria-label="用量趋势图"></svg>
                            <div id="chartTooltip" class="chart-tooltip" role="status" hidden></div>
                            <div id="chartEmpty" class="chart-empty" hidden>当前范围没有可绘制的数据</div>
                        </div>
                    </section>
                    <aside class="insight-column">
                        <section class="card cache-card">
                            <div class="card-heading"><h2>缓存效率</h2><span class="subtle-badge">输入复用</span></div>
                            <div class="cache-value" id="cacheValue">—</div>
                            <div class="meter" role="meter" aria-label="缓存命中率" aria-valuemin="0" aria-valuemax="100" id="cacheMeter"><div id="cacheFill"></div></div>
                            <div class="cache-breakdown"><span>缓存读取 <strong id="cacheRead">—</strong></span><span>缓存写入 <strong id="cacheWrite">—</strong></span></div>
                        </section>
                        <section class="card composition-card">
                            <div class="card-heading"><h2>Token 构成</h2><span class="subtle-badge" id="compositionTotal">—</span></div>
                            <div class="composition-bar" id="compositionBar" aria-hidden="true"></div>
                            <div class="composition-legend" id="compositionLegend"></div>
                        </section>
                    </aside>
                </div>

                <section class="card details-card">
                    <div class="details-header"><div class="tabs" role="tablist" aria-label="用量明细">
                        <button role="tab" id="tab-daily" aria-selected="true" data-tab="daily">每日明细</button>
                        <button role="tab" id="tab-models" aria-selected="false" data-tab="models">按模型</button>
                        <button role="tab" id="tab-providers" aria-selected="false" data-tab="providers">按供应商</button>
                    </div><span class="table-hint">完整数值 · 与上方同口径</span></div>
                    <div class="table-wrap" id="detailsTable" role="tabpanel" aria-labelledby="tab-daily"></div>
                </section>

                <p class="data-note" id="dataNote">Token 来自本地记录；成本为模型定价估算，不等于供应商实际账单。</p>
            </div>
            <div id="emptyState" class="empty-state card" hidden><span aria-hidden="true">⌁</span><h2>这段时间还很安静</h2><p>使用 Claude Code 发起对话后，用量会显示在这里。</p><button id="emptyRefresh" type="button">重新读取</button></div>
            <div id="initialLoading" class="initial-loading">正在整理本地用量…</div>
        </main>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    public dispose(): void {
        HistoryPanel.currentPanel = undefined;
        this.refreshVersion++;
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.panel.dispose();
    }
}
