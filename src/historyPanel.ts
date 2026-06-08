import * as vscode from 'vscode';
import {
    getUsageSummary,
    getDailyTrends,
    type UsageSummary,
    type DailyStats,
} from './ccswitchDb';

function formatTokens(n: number): string {
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(2)}`;
    }
    if (n >= 1_000) {
        return `${(n / 1_000).toFixed(1)}`;
    }
    return n.toString();
}

function formatTokensWan(n: number): string {
    if (n >= 10_000) {
        return `${(n / 10_000).toFixed(1)}万`;
    }
    return n.toString();
}

function formatCost(usd: number): string {
    return `$${usd.toFixed(4)}`;
}

function formatPct(n: number): string {
    return `${(n * 100).toFixed(1)}%`;
}

function getDateRangePreset(preset: string): { start: Date; end: Date } {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    switch (preset) {
        case 'today': {
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
            return { start, end };
        }
        case 'yesterday': {
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0);
            const yEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
            return { start, end: yEnd };
        }
        case 'week': {
            const day = now.getDay() || 7;
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1, 0, 0, 0);
            return { start, end };
        }
        case 'month': {
            const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
            return { start, end };
        }
        default: {
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
            return { start, end };
        }
    }
}

export class HistoryPanel {
    public static currentPanel: HistoryPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private currentPreset = 'today';

    public static createOrShow() {
        const column = vscode.ViewColumn.One;
        if (HistoryPanel.currentPanel) {
            HistoryPanel.currentPanel.panel.reveal(column);
            HistoryPanel.currentPanel.refreshData();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'ccstatusline.history',
            'Claude Code 使用统计',
            column,
            { enableScripts: true }
        );

        HistoryPanel.currentPanel = new HistoryPanel(panel);
    }

    private constructor(panel: vscode.WebviewPanel) {
        this.panel = panel;
        this.panel.webview.html = this.getHtml();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'ready':
                        this.refreshData();
                        return;
                    case 'refresh':
                        this.refreshData();
                        return;
                    case 'changePreset':
                        this.currentPreset = message.preset;
                        this.refreshData();
                        return;
                }
            },
            null,
            this.disposables
        );
    }

    private async refreshData() {
        try {
            this.panel.webview.postMessage({ command: 'loading' });

            const { start, end } = getDateRangePreset(this.currentPreset);
            console.log('[ccstatusline] refreshData range:', start.toISOString(), 'to', end.toISOString());

            const [summary, trends] = await Promise.all([
                getUsageSummary(start, end, 'claude'),
                getDailyTrends(start, end, 'claude'),
            ]);

            console.log('[ccstatusline] summary:', JSON.stringify(summary));
            console.log('[ccstatusline] trends count:', trends.length);

            this.panel.webview.postMessage({
                command: 'setData',
                summary,
                trends,
                preset: this.currentPreset,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[ccstatusline] refreshData error:', msg);
            this.panel.webview.postMessage({
                command: 'error',
                message: msg,
            });
        }
    }

    private getHtml(): string {
        return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Claude Code 使用统计</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        .container { max-width: 800px; margin: 0 auto; }

        .header {
            margin-bottom: 16px;
        }
        .header h1 {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 4px;
        }
        .header p {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }

        .toolbar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            gap: 8px;
        }
        .preset-select {
            padding: 6px 10px;
            font-size: 13px;
            border-radius: 6px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            cursor: pointer;
        }
        .btn {
            padding: 6px 14px;
            font-size: 13px;
            border-radius: 6px;
            border: 1px solid var(--vscode-button-border);
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer;
        }
        .btn:hover { opacity: 0.9; }

        .hero-card {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 16px;
        }
        .hero-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 12px;
        }
        .hero-icon {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            background: #f59e0b;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
        }
        .hero-title {
            font-size: 14px;
            color: var(--vscode-descriptionForeground);
        }
        .hero-main {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            flex-wrap: wrap;
            gap: 16px;
        }
        .hero-number {
            font-size: 36px;
            font-weight: 700;
            line-height: 1;
            margin-bottom: 6px;
        }
        .hero-sub {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        .hero-meta {
            display: flex;
            gap: 20px;
            text-align: right;
        }
        .hero-meta-item {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        .hero-meta-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .hero-meta-value {
            font-size: 14px;
            font-weight: 600;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 12px;
            margin-bottom: 16px;
        }
        .stat-card {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 10px;
            padding: 16px;
        }
        .stat-card-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
        }
        .stat-card-value {
            font-size: 20px;
            font-weight: 600;
        }

        .progress-section {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 10px;
            padding: 16px;
            margin-bottom: 16px;
        }
        .progress-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .progress-label {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        .progress-value {
            font-size: 14px;
            font-weight: 600;
            color: #10b981;
        }
        .progress-bar-bg {
            height: 8px;
            background: var(--vscode-progressBar-background);
            border-radius: 4px;
            overflow: hidden;
        }
        .progress-bar-fill {
            height: 100%;
            background: #10b981;
            border-radius: 4px;
            transition: width 0.3s ease;
        }

        .pet-section {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 12px;
            padding: 20px 24px;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 20px;
            position: relative;
            overflow: hidden;
        }
        .pet-section::before {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: radial-gradient(circle at 30% 50%, rgba(245, 158, 11, 0.08) 0%, transparent 50%);
            pointer-events: none;
        }
        .pet-canvas {
            width: 80px;
            height: 80px;
            flex-shrink: 0;
            position: relative;
            cursor: pointer;
            transition: transform 0.2s ease;
        }
        .pet-canvas:hover {
            transform: scale(1.05);
        }
        .pet-canvas:active {
            transform: scale(0.95);
        }
        .pet-body {
            width: 56px;
            height: 48px;
            background: #f59e0b;
            border-radius: 50%;
            position: absolute;
            bottom: 8px;
            left: 50%;
            transform: translateX(-50%);
            animation: petFloat 2.5s ease-in-out infinite;
            box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3);
        }
        .pet-eye {
            width: 10px;
            height: 10px;
            background: #1f2937;
            border-radius: 50%;
            position: absolute;
            top: 14px;
            animation: petBlink 4s ease-in-out infinite;
        }
        .pet-eye.left { left: 12px; }
        .pet-eye.right { right: 12px; }
        .pet-eye::after {
            content: '';
            width: 3px;
            height: 3px;
            background: white;
            border-radius: 50%;
            position: absolute;
            top: 2px;
            right: 2px;
        }
        .pet-tentacle {
            width: 8px;
            height: 18px;
            background: #f59e0b;
            border-radius: 4px;
            position: absolute;
            bottom: -8px;
            animation: petWiggle 1.5s ease-in-out infinite;
        }
        .pet-tentacle.t1 { left: 8px; animation-delay: 0s; }
        .pet-tentacle.t2 { left: 20px; animation-delay: 0.2s; }
        .pet-tentacle.t3 { right: 20px; animation-delay: 0.4s; }
        .pet-tentacle.t4 { right: 8px; animation-delay: 0.6s; }
        .pet-blush {
            width: 10px;
            height: 6px;
            background: rgba(239, 68, 68, 0.3);
            border-radius: 50%;
            position: absolute;
            top: 26px;
        }
        .pet-blush.left { left: 6px; }
        .pet-blush.right { right: 6px; }
        .pet-mouth {
            width: 12px;
            height: 6px;
            border-bottom: 2px solid #1f2937;
            border-radius: 0 0 50% 50%;
            position: absolute;
            top: 28px;
            left: 50%;
            transform: translateX(-50%);
        }
        .pet-heart {
            position: absolute;
            color: #ef4444;
            font-size: 16px;
            pointer-events: none;
            opacity: 0;
            animation: none;
        }
        .pet-heart.active {
            animation: heartFloat 1s ease-out forwards;
        }
        .pet-info {
            flex: 1;
            min-width: 0;
            position: relative;
            z-index: 1;
        }
        .pet-name {
            font-size: 15px;
            font-weight: 600;
            margin-bottom: 4px;
        }
        .pet-status {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
        }
        .pet-stats {
            display: flex;
            gap: 16px;
        }
        .pet-stat {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        .pet-stat-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .pet-stat-value {
            font-size: 13px;
            font-weight: 600;
        }
        .pet-bar {
            width: 80px;
            height: 4px;
            background: var(--vscode-progressBar-background);
            border-radius: 2px;
            overflow: hidden;
            margin-top: 2px;
        }
        .pet-bar-fill {
            height: 100%;
            border-radius: 2px;
            transition: width 0.5s ease;
        }
        .pet-bar-fill.mood { background: #f59e0b; }
        .pet-bar-fill.energy { background: #10b981; }
        @keyframes petFloat {
            0%, 100% { transform: translateX(-50%) translateY(0); }
            50% { transform: translateX(-50%) translateY(-4px); }
        }
        @keyframes petBlink {
            0%, 48%, 52%, 100% { transform: scaleY(1); }
            50% { transform: scaleY(0.1); }
        }
        @keyframes petWiggle {
            0%, 100% { transform: rotate(-5deg); }
            50% { transform: rotate(5deg); }
        }
        @keyframes heartFloat {
            0% { opacity: 1; transform: translateY(0) scale(0.5); }
            50% { opacity: 1; transform: translateY(-20px) scale(1); }
            100% { opacity: 0; transform: translateY(-40px) scale(1.2); }
        }
        .pet-jump {
            animation: petJump 0.4s ease-out !important;
        }
        @keyframes petJump {
            0% { transform: translateX(-50%) translateY(0) scale(1); }
            40% { transform: translateX(-50%) translateY(-20px) scale(1.1); }
            100% { transform: translateX(-50%) translateY(0) scale(1); }
        }

        .trend-table {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 10px;
            overflow: hidden;
        }
        .trend-table-header {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr 1fr 1fr;
            padding: 12px 16px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
        }
        .trend-row {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr 1fr 1fr;
            padding: 10px 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 13px;
        }
        .trend-row:last-child {
            border-bottom: none;
        }

        .loading, .error, .empty {
            text-align: center;
            padding: 60px 20px;
        }
        .error {
            color: var(--vscode-errorForeground);
        }

        @media (max-width: 600px) {
            .stats-grid { grid-template-columns: repeat(2, 1fr); }
            .hero-main { flex-direction: column; }
            .hero-meta { text-align: left; width: 100%; }
            .trend-table-header,
            .trend-row { grid-template-columns: 1fr 1fr; gap: 8px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Claude Code 使用统计</h1>
            <p>数据来源: ~/.cc-switch/cc-switch.db</p>
        </div>

        <div class="pet-section" id="petSection" style="display:none;">
            <div class="pet-canvas" id="petCanvas" title="点击我！">
                <div class="pet-heart" id="petHeart">❤</div>
                <div class="pet-body" id="petBody">
                    <div class="pet-eye left"></div>
                    <div class="pet-eye right"></div>
                    <div class="pet-blush left"></div>
                    <div class="pet-blush right"></div>
                    <div class="pet-mouth"></div>
                </div>
                <div class="pet-tentacle t1"></div>
                <div class="pet-tentacle t2"></div>
                <div class="pet-tentacle t3"></div>
                <div class="pet-tentacle t4"></div>
            </div>
            <div class="pet-info">
                <div class="pet-name">Claude 小章鱼</div>
                <div class="pet-status" id="petStatus">正在休息...</div>
                <div class="pet-stats">
                    <div class="pet-stat">
                        <span class="pet-stat-label">心情</span>
                        <span class="pet-stat-value" id="petMoodVal">--</span>
                        <div class="pet-bar"><div class="pet-bar-fill mood" id="petMoodBar" style="width:0%"></div></div>
                    </div>
                    <div class="pet-stat">
                        <span class="pet-stat-label">活跃</span>
                        <span class="pet-stat-value" id="petEnergyVal">--</span>
                        <div class="pet-bar"><div class="pet-bar-fill energy" id="petEnergyBar" style="width:0%"></div></div>
                    </div>
                </div>
            </div>
        </div>

        <div class="toolbar">
            <select class="preset-select" id="presetSelect">
                <option value="today">今日</option>
                <option value="yesterday">昨日</option>
                <option value="week">本周</option>
                <option value="month">本月</option>
            </select>
            <button class="btn" id="refreshBtn">刷新</button>
        </div>

        <div id="content">
            <div class="loading">正在加载数据...</div>
        </div>
    </div>

    <script>
        (function() {
            var vscode;
            try {
                vscode = acquireVsCodeApi();
            } catch (e) {
                document.getElementById('content').innerHTML = '<div class="error">acquireVsCodeApi 失败</div>';
                return;
            }

            function formatTokens(n) {
                if (n >= 1000000) return (n / 1000000).toFixed(2);
                if (n >= 1000) return (n / 1000).toFixed(1);
                return n.toString();
            }

            function formatTokensWan(n) {
                if (n >= 10000) return (n / 10000).toFixed(1) + '万';
                return n.toString();
            }

            function formatCost(usd) {
                return '$' + usd.toFixed(4);
            }

            function formatPct(n) {
                return (n * 100).toFixed(1) + '%';
            }

            // ========== Pet System ==========
            var petState = {
                mood: 60,
                energy: 50,
                clickCount: 0,
                lastClick: 0
            };

            function computePetState(summary) {
                var tokens = summary ? (summary.realTotalTokens || 0) : 0;
                var requests = summary ? (summary.totalRequests || 0) : 0;
                // Energy based on tokens usage (more usage = more active)
                var energy = Math.min(100, 20 + Math.min(tokens / 5000, 80));
                // Mood based on request count + click bonus
                var mood = Math.min(100, 30 + Math.min(requests * 3, 50) + Math.min(petState.clickCount * 5, 20));
                petState.energy = Math.round(energy);
                petState.mood = Math.round(mood);
            }

            function renderPet() {
                var section = document.getElementById('petSection');
                if (!section) { return; }
                section.style.display = 'flex';
                var moodEl = document.getElementById('petMoodVal');
                var moodBar = document.getElementById('petMoodBar');
                var energyEl = document.getElementById('petEnergyVal');
                var energyBar = document.getElementById('petEnergyBar');
                var statusEl = document.getElementById('petStatus');
                if (moodEl) { moodEl.textContent = petState.mood; }
                if (moodBar) { moodBar.style.width = petState.mood + '%'; }
                if (energyEl) { energyEl.textContent = petState.energy; }
                if (energyBar) { energyBar.style.width = petState.energy + '%'; }
                if (statusEl) {
                    var msgs = [
                        { threshold: 80, text: '超开心！今天写了很多代码呢~' },
                        { threshold: 60, text: '心情不错，继续加油！' },
                        { threshold: 40, text: '还不错，去写点代码吧~' },
                        { threshold: 20, text: '有点无聊...快敲键盘！' },
                        { threshold: 0, text: '...我快睡着了' }
                    ];
                    var msg = msgs.find(function(m) { return petState.mood >= m.threshold; });
                    statusEl.textContent = msg ? msg.text : '...';
                }
            }

            function petInteract() {
                var now = Date.now();
                if (now - petState.lastClick < 300) { return; }
                petState.lastClick = now;
                petState.clickCount++;
                petState.mood = Math.min(100, petState.mood + 5);

                var body = document.getElementById('petBody');
                var heart = document.getElementById('petHeart');
                if (body) {
                    body.classList.remove('pet-jump');
                    void body.offsetWidth;
                    body.classList.add('pet-jump');
                    setTimeout(function() { body.classList.remove('pet-jump'); }, 400);
                }
                if (heart) {
                    heart.classList.remove('active');
                    void heart.offsetWidth;
                    heart.classList.add('active');
                    setTimeout(function() { heart.classList.remove('active'); }, 1000);
                }
                renderPet();
            }

            document.getElementById('petCanvas').addEventListener('click', petInteract);

            function renderHero(summary) {
                return '<div class="hero-card">' +
                    '<div class="hero-header">' +
                        '<div class="hero-icon">⚡</div>' +
                        '<span class="hero-title">Claude Code · 真实消耗 Tokens</span>' +
                    '</div>' +
                    '<div class="hero-main">' +
                        '<div>' +
                            '<div class="hero-number">' + formatTokens(summary.realTotalTokens) + '</div>' +
                            '<div class="hero-sub">≈ ' + formatTokensWan(summary.realTotalTokens) + ' tokens</div>' +
                        '</div>' +
                        '<div class="hero-meta">' +
                            '<div class="hero-meta-item">' +
                                '<span class="hero-meta-label">总请求数</span>' +
                                '<span class="hero-meta-value">' + summary.totalRequests + '</span>' +
                            '</div>' +
                            '<div class="hero-meta-item">' +
                                '<span class="hero-meta-label">总成本</span>' +
                                '<span class="hero-meta-value">' + formatCost(summary.totalCost) + '</span>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>';
            }

            function renderStatsGrid(summary) {
                return '<div class="stats-grid">' +
                    '<div class="stat-card">' +
                        '<div class="stat-card-label">新增输入</div>' +
                        '<div class="stat-card-value">' + formatTokensWan(summary.totalInputTokens) + '</div>' +
                    '</div>' +
                    '<div class="stat-card">' +
                        '<div class="stat-card-label">Output</div>' +
                        '<div class="stat-card-value">' + formatTokensWan(summary.totalOutputTokens) + '</div>' +
                    '</div>' +
                    '<div class="stat-card">' +
                        '<div class="stat-card-label">创建</div>' +
                        '<div class="stat-card-value">' + summary.totalCacheCreationTokens + '</div>' +
                    '</div>' +
                    '<div class="stat-card">' +
                        '<div class="stat-card-label">命中</div>' +
                        '<div class="stat-card-value">' + formatTokensWan(summary.totalCacheReadTokens) + '</div>' +
                    '</div>' +
                '</div>';
            }

            function renderCacheHitRate(summary) {
                return '<div class="progress-section">' +
                    '<div class="progress-header">' +
                        '<span class="progress-label">缓存命中率</span>' +
                        '<span class="progress-value">' + formatPct(summary.cacheHitRate) + '</span>' +
                    '</div>' +
                    '<div class="progress-bar-bg">' +
                        '<div class="progress-bar-fill" style="width:' + (summary.cacheHitRate * 100) + '%"></div>' +
                    '</div>' +
                '</div>';
            }

            function renderTrends(trends) {
                if (!trends || trends.length === 0) {
                    return '';
                }
                var html = '<div class="trend-table">' +
                    '<div class="trend-table-header">' +
                        '<div>日期</div>' +
                        '<div>请求数</div>' +
                        '<div>输入</div>' +
                        '<div>输出</div>' +
                        '<div>成本</div>' +
                    '</div>';
                for (var i = 0; i < trends.length; i++) {
                    var t = trends[i];
                    html += '<div class="trend-row">' +
                        '<div>' + t.date + '</div>' +
                        '<div>' + t.requestCount + '</div>' +
                        '<div>' + formatTokensWan(t.inputTokens) + '</div>' +
                        '<div>' + formatTokensWan(t.outputTokens) + '</div>' +
                        '<div>' + formatCost(t.totalCost) + '</div>' +
                    '</div>';
                }
                html += '</div>';
                return html;
            }

            function render(data) {
                var content = document.getElementById('content');

                if (!data || !data.summary) {
                    content.innerHTML = '<div class="empty">暂无数据</div>';
                    document.getElementById('petSection').style.display = 'flex';
                    computePetState(null);
                    renderPet();
                    return;
                }

                computePetState(data.summary);
                renderPet();

                var html = renderHero(data.summary) +
                    renderStatsGrid(data.summary) +
                    renderCacheHitRate(data.summary) +
                    renderTrends(data.trends);

                content.innerHTML = html;
            }

            function showLoading() {
                document.getElementById('content').innerHTML = '<div class="loading">正在加载数据...</div>';
            }

            function showError(msg) {
                document.getElementById('content').innerHTML = '<div class="error">加载失败: ' + msg + '</div>';
            }

            document.getElementById('presetSelect').addEventListener('change', function(e) {
                vscode.postMessage({ command: 'changePreset', preset: e.target.value });
                showLoading();
            });

            document.getElementById('refreshBtn').addEventListener('click', function() {
                vscode.postMessage({ command: 'refresh' });
                showLoading();
            });

            window.addEventListener('message', function(event) {
                var msg = event.data;
                console.log('[webview] received:', msg.command);
                switch (msg.command) {
                    case 'loading':
                        showLoading();
                        break;
                    case 'setData':
                        console.log('[webview] data:', JSON.stringify(msg.summary));
                        render(msg);
                        if (msg.preset) {
                            document.getElementById('presetSelect').value = msg.preset;
                        }
                        break;
                    case 'error':
                        showError(msg.message);
                        break;
                }
            });

            // Always send ready
            vscode.postMessage({ command: 'ready' });
        })();
    </script>
</body>
</html>`;
    }

    public dispose() {
        HistoryPanel.currentPanel = undefined;
        this.panel.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
