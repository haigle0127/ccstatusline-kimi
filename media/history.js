(() => {
    'use strict';
    const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
    const $ = id => document.getElementById(id);
    const state = { data: null, metric: 'tokens', tab: 'daily', petClicks: 0, petTimer: null };
    const number = new Intl.NumberFormat('zh-CN');
    const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
    const svgNS = 'http://www.w3.org/2000/svg';
    const metricInfo = {
        tokens: { title: 'Token 趋势', unit: 'tokens', field: 'totalTokens' },
        cost: { title: '成本趋势', unit: 'USD（估算）', field: 'totalCost' },
        requests: { title: '请求数趋势', unit: '次', field: 'requestCount' },
        hitRate: { title: '缓存命中率趋势', unit: '%', field: 'cacheHitRate' }
    };

    function setText(id, value) { $(id).textContent = value; }
    function full(value) { return number.format(Math.round(Number(value) || 0)); }
    function short(value) { return compact.format(Number(value) || 0); }
    function percent(value) { return value === null || value === undefined ? '—' : `${Number(value).toFixed(1)}%`; }
    function cost(value) {
        const n = Number(value) || 0;
        if (n >= 1) { return `$${n.toFixed(2)}`; }
        if (n >= .01) { return `$${n.toFixed(3)}`; }
        return `$${n.toFixed(4)}`;
    }
    function exactCost(value) { return `$${(Number(value) || 0).toFixed(6)}`; }
    function metricValue(metric, value) {
        if (metric === 'cost') { return cost(value); }
        if (metric === 'requests') { return full(value); }
        if (metric === 'hitRate') { return percent(value); }
        return short(value);
    }
    function exactMetricValue(metric, value) {
        if (metric === 'cost') { return exactCost(value); }
        if (metric === 'requests') { return full(value); }
        if (metric === 'hitRate') { return percent(value); }
        return full(value);
    }
    function localParts(value) {
        const date = new Date(value);
        return {
            day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
            shortDay: `${date.getMonth() + 1}/${date.getDate()}`,
            hour: `${String(date.getHours()).padStart(2, '0')}:00`
        };
    }
    function svg(tag, attrs = {}, text) {
        const element = document.createElementNS(svgNS, tag);
        for (const [key, value] of Object.entries(attrs)) { element.setAttribute(key, String(value)); }
        if (text !== undefined) { element.textContent = text; }
        return element;
    }

    function renderSummary() {
        const { summary: s } = state.data;
        setText('metricTokens', short(s.realTotalTokens));
        $('metricTokens').title = full(s.realTotalTokens);
        const partial = s.unpricedRequests > 0;
        setText('metricCost', s.totalRequests > 0 && partial && s.totalCost === 0 ? '未定价' : `${cost(s.totalCost)}${partial ? '*' : ''}`);
        $('metricCost').title = `${exactCost(s.totalCost)}${partial ? `，${s.unpricedRequests} 条请求未定价` : ''}`;
        setText('metricCostSub', partial ? `${s.unpricedRequests} 条未定价 · 仅含已计价` : '按 CC Switch 定价估算');
        setText('metricRequests', full(s.totalRequests));
        setText('metricSuccess', s.successRate === null ? '会话记录不提供成功率' : `成功率 ${percent(s.successRate)}`);
        setText('metricHitRate', percent(s.cacheHitRate));
        setText('cacheValue', percent(s.cacheHitRate));
        $('cacheMeter').setAttribute('aria-valuenow', String(s.cacheHitRate ?? 0));
        $('cacheMeter').setAttribute('aria-valuetext', percent(s.cacheHitRate));
        $('cacheFill').style.width = `${Math.max(0, Math.min(100, s.cacheHitRate ?? 0))}%`;
        setText('cacheRead', short(s.totalCacheReadTokens));
        setText('cacheWrite', short(s.totalCacheCreationTokens));
        setText('sourceLabel', state.data.sourceLabel);
        setText('updatedAt', `更新于 ${new Date(state.data.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
        setText('dataNote', `Token 来自${state.data.sourceLabel}；成本为模型定价估算，不等于供应商实际账单。${partial ? ' * 金额未包含缺定价的请求。' : ''}`);
        renderComposition();
        renderPet();
    }

    function renderComposition() {
        const s = state.data.summary;
        const items = [
            { name: '新增输入', value: s.totalInputTokens, color: 'var(--series-1)' },
            { name: '模型输出', value: s.totalOutputTokens, color: 'var(--series-2)' },
            { name: '缓存写入', value: s.totalCacheCreationTokens, color: 'var(--series-3)' },
            { name: '缓存读取', value: s.totalCacheReadTokens, color: 'var(--series-4)' }
        ];
        setText('compositionTotal', short(s.realTotalTokens));
        const bar = $('compositionBar');
        const legend = $('compositionLegend');
        bar.replaceChildren();
        legend.replaceChildren();
        for (const item of items) {
            const share = s.realTotalTokens > 0 ? item.value / s.realTotalTokens * 100 : 0;
            const segment = document.createElement('span');
            segment.style.width = `${share}%`;
            segment.style.backgroundColor = item.color;
            bar.append(segment);
            const row = document.createElement('div');
            row.className = 'composition-item';
            row.title = `${item.name}: ${full(item.value)} (${share.toFixed(1)}%)`;
            const swatch = document.createElement('span');
            swatch.className = 'composition-swatch';
            swatch.style.backgroundColor = item.color;
            const name = document.createElement('span');
            name.textContent = item.name;
            const value = document.createElement('strong');
            value.textContent = `${share.toFixed(0)}%`;
            row.append(swatch, name, value);
            legend.append(row);
        }
    }

    function renderChart() {
        if (!state.data) { return; }
        const chart = $('trendChart');
        const tooltip = $('chartTooltip');
        const info = metricInfo[state.metric];
        const trends = state.data.trends;
        tooltip.hidden = true;
        chart.replaceChildren();
        setText('trendTitle', info.title);
        setText('trendSubtitle', state.data.isHourly ? '按小时统计 · 悬停或 Tab 查看数值' : '按日统计 · 悬停或 Tab 查看数值');
        setText('chartUnit', info.unit);
        chart.setAttribute('aria-label', `${info.title}，详细数据见下方表格`);

        const values = trends.map(t => t[info.field]);
        const hasValues = values.some(v => v !== null && v !== undefined && Number(v) > 0);
        $('chartEmpty').hidden = hasValues;
        if (!hasValues) { return; }

        const width = Math.max(180, Math.round($('chartWrap').clientWidth || 720)), height = 250;
        chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
        const margin = { top: 18, right: width < 360 ? 12 : 20, bottom: 34, left: width < 360 ? 48 : 56 };
        const plotWidth = width - margin.left - margin.right;
        const plotHeight = height - margin.top - margin.bottom;
        const numericValues = values.map(v => Math.max(0, Number(v) || 0));
        const max = Math.max(...numericValues, state.metric === 'hitRate' ? 100 : 0, 1);
        const x = index => margin.left + (trends.length === 1 ? plotWidth / 2 : index / (trends.length - 1) * plotWidth);
        const y = value => margin.top + plotHeight - value / max * plotHeight;
        const tickMax = state.metric === 'hitRate' ? 100 : max;

        for (let i = 0; i <= 3; i++) {
            const value = tickMax * (1 - i / 3);
            const py = margin.top + plotHeight * i / 3;
            chart.append(svg('line', { x1: margin.left, x2: width - margin.right, y1: py, y2: py, class: 'chart-grid' }));
            const axisText = width < 400 && state.metric === 'tokens'
                ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
                : metricValue(state.metric, value);
            chart.append(svg('text', { x: margin.left - 9, y: py + 3, 'text-anchor': 'end', class: 'chart-axis-text' }, axisText));
        }
        const labelStep = Math.max(1, Math.ceil(trends.length / Math.max(2, Math.floor(plotWidth / 70))));
        trends.forEach((trend, index) => {
            if (index % labelStep !== 0 && index !== trends.length - 1) { return; }
            const parts = localParts(trend.date);
            chart.append(svg('text', { x: x(index), y: height - 9, 'text-anchor': 'middle', class: 'chart-axis-text' }, state.data.isHourly ? parts.hour : parts.shortDay));
        });

        const points = numericValues.map((value, index) => [x(index), y(value)]);
        const linePath = points.map((point, index) => `${index ? 'L' : 'M'}${point[0].toFixed(2)},${point[1].toFixed(2)}`).join(' ');
        const areaPath = `${linePath} L${points[points.length - 1][0]},${margin.top + plotHeight} L${points[0][0]},${margin.top + plotHeight} Z`;
        chart.append(svg('path', { d: areaPath, class: 'chart-area', 'aria-hidden': 'true' }));
        chart.append(svg('path', { d: linePath, class: 'chart-line', 'aria-hidden': 'true' }));

        const lastIndex = numericValues.reduce((best, value, index) => value > 0 ? index : best, 0);
        const last = points[lastIndex];
        chart.append(svg('circle', { cx: last[0], cy: last[1], r: 4, class: 'chart-point', 'aria-hidden': 'true' }));
        const labelX = Math.max(margin.left + 12, Math.min(width - margin.right - 12, last[0]));
        const labelY = Math.max(12, last[1] - 11);
        chart.append(svg('text', { x: labelX, y: labelY, 'text-anchor': 'middle', class: 'chart-axis-text', style: 'fill:var(--text-secondary);font-weight:600' }, metricValue(state.metric, numericValues[lastIndex])));

        const crosshair = svg('line', { y1: margin.top, y2: margin.top + plotHeight, class: 'chart-crosshair', visibility: 'hidden', 'aria-hidden': 'true' });
        const hoverPoint = svg('circle', { r: 4, class: 'chart-point', visibility: 'hidden', 'aria-hidden': 'true' });
        chart.append(crosshair, hoverPoint);
        const band = plotWidth / Math.max(1, trends.length - 1);
        function show(index) {
            const parts = localParts(trends[index].date);
            const title = state.data.isHourly ? `${parts.day} ${parts.hour}` : parts.day;
            const value = values[index];
            crosshair.setAttribute('x1', x(index)); crosshair.setAttribute('x2', x(index));
            crosshair.setAttribute('visibility', 'visible');
            hoverPoint.setAttribute('cx', x(index)); hoverPoint.setAttribute('cy', y(Number(value) || 0));
            hoverPoint.setAttribute('visibility', 'visible');
            tooltip.replaceChildren();
            const caption = document.createElement('span'); caption.textContent = title;
            const amount = document.createElement('strong'); amount.textContent = `${exactMetricValue(state.metric, value)}${state.metric === 'cost' && trends[index].unpricedRequests ? '*' : ''}`;
            tooltip.append(caption, amount);
            tooltip.hidden = false;
            const chartWidth = $('chartWrap').clientWidth;
            const px = x(index) / width * chartWidth;
            tooltip.style.left = `${Math.max(4, Math.min(chartWidth - 150, px - 65))}px`;
            tooltip.style.top = `${Math.max(2, y(Number(value) || 0) / height * $('chartWrap').clientHeight - 54)}px`;
        }
        function hide() {
            crosshair.setAttribute('visibility', 'hidden'); hoverPoint.setAttribute('visibility', 'hidden'); tooltip.hidden = true;
        }
        trends.forEach((trend, index) => {
            const hitWidth = trends.length === 1 ? plotWidth : Math.max(12, band);
            const hit = svg('rect', {
                x: Math.max(margin.left, x(index) - hitWidth / 2), y: margin.top,
                width: Math.min(hitWidth, width - margin.right - Math.max(margin.left, x(index) - hitWidth / 2)), height: plotHeight,
                class: 'chart-hit', tabindex: '0', role: 'img',
                'aria-label': `${localParts(trend.date).day} ${state.data.isHourly ? localParts(trend.date).hour : ''}: ${exactMetricValue(state.metric, values[index])}`
            });
            hit.addEventListener('pointerenter', () => show(index));
            hit.addEventListener('pointerleave', hide);
            hit.addEventListener('focus', () => show(index));
            hit.addEventListener('blur', hide);
            chart.append(hit);
        });
    }

    function cell(row, value, title) {
        const td = document.createElement('td');
        td.textContent = value;
        if (title) { td.title = title; }
        row.append(td);
    }
    function renderTable() {
        if (!state.data) { return; }
        const wrap = $('detailsTable');
        wrap.setAttribute('aria-labelledby', `tab-${state.tab}`);
        wrap.replaceChildren();
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const header = document.createElement('tr');
        const columns = state.tab === 'daily'
            ? [state.data.isHourly ? '时段' : '日期', '请求', '总 Tokens', '新增输入', '输出', '缓存命中', '估算成本']
            : state.tab === 'models'
                ? ['模型', '请求', '总 Tokens', '估算成本', '定价状态']
                : ['供应商', '请求', '总 Tokens', '成功率', '估算成本'];
        for (const name of columns) {
            const th = document.createElement('th'); th.scope = 'col'; th.textContent = name; header.append(th);
        }
        thead.append(header);
        const tbody = document.createElement('tbody');
        let rows;
        if (state.tab === 'daily') {
            rows = [...state.data.trends].reverse().filter(row => row.requestCount > 0 || row.totalTokens > 0);
            for (const item of rows) {
                const tr = document.createElement('tr');
                const parts = localParts(item.date);
                cell(tr, state.data.isHourly ? `${parts.day} ${parts.hour}` : parts.day);
                cell(tr, full(item.requestCount));
                cell(tr, full(item.totalTokens));
                cell(tr, full(item.inputTokens));
                cell(tr, full(item.outputTokens));
                cell(tr, percent(item.cacheHitRate));
                cell(tr, `${exactCost(item.totalCost)}${item.unpricedRequests ? '*' : ''}`);
                tbody.append(tr);
            }
        } else if (state.tab === 'models') {
            rows = state.data.models;
            for (const item of rows) {
                const tr = document.createElement('tr');
                cell(tr, item.model, item.model);
                cell(tr, full(item.requestCount));
                cell(tr, full(item.totalTokens));
                cell(tr, `${exactCost(item.totalCost)}${item.unpricedRequests ? '*' : ''}`);
                cell(tr, item.unpricedRequests === item.requestCount ? '未定价' : item.unpricedRequests ? `${item.unpricedRequests} 条缺失` : '已计价');
                tbody.append(tr);
            }
        } else {
            rows = state.data.providers;
            for (const item of rows) {
                const tr = document.createElement('tr');
                cell(tr, item.providerName, item.providerName);
                cell(tr, full(item.requestCount));
                cell(tr, full(item.totalTokens));
                cell(tr, percent(item.successRate));
                cell(tr, `${exactCost(item.totalCost)}${item.unpricedRequests ? '*' : ''}`);
                tbody.append(tr);
            }
        }
        if (rows.length === 0) {
            const tr = document.createElement('tr');
            const td = document.createElement('td'); td.colSpan = columns.length; td.className = 'table-empty'; td.textContent = '暂无明细数据';
            tr.append(td); tbody.append(tr);
        }
        table.append(thead, tbody); wrap.append(table);
    }

    function renderPet() {
        const s = state.data.summary;
        const energy = Math.min(100, Math.round(25 + Math.log10(s.realTotalTokens + 1) / 7 * 65 + state.petClicks * 3));
        setText('petEnergy', `${energy}%`);
        $('petEnergyFill').style.width = `${energy}%`;
        setText('petStatus', state.petClicks > 0 ? '收到鼓励，继续加油！' : s.totalRequests > 0 ? `陪你完成了 ${full(s.totalRequests)} 次请求` : '等你一起写代码');
    }
    function selectTab(tab) {
        state.tab = tab;
        document.querySelectorAll('[data-tab]').forEach(button => {
            const selected = button.dataset.tab === tab;
            button.setAttribute('aria-selected', String(selected));
            button.tabIndex = selected ? 0 : -1;
        });
        renderTable();
    }
    function setLoading(loading) {
        $('refreshBtn').classList.toggle('loading', loading);
        $('refreshBtn').disabled = loading;
        if (state.data) { $('content').classList.toggle('loading', loading); $('content').setAttribute('aria-busy', String(loading)); }
    }

    document.querySelectorAll('[data-metric]').forEach(button => {
        button.addEventListener('click', () => {
            state.metric = button.dataset.metric;
            document.querySelectorAll('[data-metric]').forEach(item => {
                const selected = item === button;
                item.classList.toggle('selected', selected);
                item.setAttribute('aria-pressed', String(selected));
            });
            renderChart();
        });
    });
    document.querySelectorAll('[data-tab]').forEach(button => {
        button.addEventListener('click', () => selectTab(button.dataset.tab));
        button.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) { return; }
            event.preventDefault();
            const tabs = ['daily', 'models', 'providers'];
            const next = (tabs.indexOf(state.tab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
            selectTab(next); $(`tab-${next}`).focus();
        });
    });
    $('refreshBtn').addEventListener('click', () => vscode?.postMessage({ command: 'refresh' }));
    $('emptyRefresh').addEventListener('click', () => vscode?.postMessage({ command: 'refresh' }));
    $('presetSelect').addEventListener('change', event => vscode?.postMessage({ command: 'changePreset', preset: event.target.value }));
    $('petCanvas').addEventListener('click', () => {
        state.petClicks++;
        const canvas = $('petCanvas');
        canvas.classList.remove('happy');
        void canvas.offsetWidth;
        canvas.classList.add('happy');
        clearTimeout(state.petTimer);
        state.petTimer = setTimeout(() => canvas.classList.remove('happy'), 850);
        renderPet();
    });
    window.addEventListener('message', event => {
        const message = event.data;
        if (!message || typeof message !== 'object') { return; }
        if (message.command === 'loading') { setLoading(true); $('errorBanner').hidden = true; return; }
        setLoading(false);
        if (message.command === 'error') {
            setText('errorBanner', `读取失败：${message.message}`);
            $('errorBanner').hidden = false;
            if (!state.data) { $('initialLoading').hidden = true; $('content').hidden = true; }
            return;
        }
        if (message.command !== 'setData') { return; }
        state.data = message.data;
        $('presetSelect').value = message.preset;
        $('errorBanner').hidden = true;
        $('initialLoading').hidden = true;
        const hasData = state.data.summary.totalRequests > 0 || state.data.summary.realTotalTokens > 0;
        $('content').hidden = !hasData;
        $('emptyState').hidden = hasData;
        if (!hasData) { return; }
        $('content').setAttribute('aria-busy', 'false');
        setText('tab-daily', state.data.isHourly ? '时段明细' : '每日明细');
        renderSummary(); renderChart(); renderTable();
    });
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(renderChart, 100);
    });
    if (vscode) { vscode.postMessage({ command: 'ready' }); }
})();
