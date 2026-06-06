import type { ClaudeSettings, CcSwitchProvider, RenderContext, WidgetResult } from './types';

const MODEL_NAME_MAP: Record<string, string> = {
    sonnet: 'Sonnet',
    opus: 'Opus',
    haiku: 'Haiku'
};

function resolveClaudeModelName(settings: ClaudeSettings | null): string {
    const raw = settings?.model ?? 'sonnet';
    const key = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    return MODEL_NAME_MAP[key] ?? raw;
}

function resolveModelName(ctx: RenderContext): string {
    const provider = ctx.state.provider;
    if (provider) {
        const envModel = provider.settingsConfig?.env?.ANTHROPIC_MODEL;
        if (envModel) {
            return envModel;
        }
        // Provider is active but didn't specify a concrete model.
        // Don't guess "Sonnet" — just show the provider name.
        return provider.name;
    }
    return resolveClaudeModelName(ctx.state.settings);
}

function formatTokens(n: number): string {
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(1)}M`;
    }
    if (n >= 1_000) {
        return `${(n / 1_000).toFixed(1)}K`;
    }
    return n.toString();
}

function formatCost(usd: number): string {
    if (usd >= 1) {
        return `$${usd.toFixed(2)}`;
    }
    if (usd >= 0.01) {
        return `$${usd.toFixed(2)}`;
    }
    return `$${usd.toFixed(4)}`;
}

function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
        return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
    }
    return `${seconds}s`;
}

export const WIDGETS: Record<string, (ctx: RenderContext) => WidgetResult | null> = {
    model(ctx) {
        const name = resolveModelName(ctx);
        const provider = ctx.state.provider;
        const tooltip = provider
            ? `模型: ${name}\n供应商: ${provider.name}`
            : `Claude 模型: ${name}`;
        return { text: name, tooltip };
    },

    'thinking-effort'(ctx) {
        const level = ctx.state.settings?.effortLevel;
        if (!level) {
            return null;
        }
        return { text: level, tooltip: `思考力度: ${level}` };
    },

    'git-branch'(ctx) {
        const branch = ctx.state.gitInfo.branch;
        if (!branch) {
            return null;
        }
        return { text: branch, tooltip: `Git 分支: ${branch}` };
    },

    'git-status'(ctx) {
        const g = ctx.state.gitInfo;
        const parts: string[] = [];
        if (g.ahead) { parts.push(`↑${g.ahead}`); }
        if (g.behind) { parts.push(`↓${g.behind}`); }
        if (g.staged) { parts.push(`+${g.staged}`); }
        if (g.unstaged) { parts.push(`*${g.unstaged}`); }
        if (g.untracked) { parts.push(`?${g.untracked}`); }
        if (g.conflicts) { parts.push(`!${g.conflicts}`); }

        if (parts.length === 0) {
            return g.branch ? { text: '✓', tooltip: '工作区干净' } : null;
        }

        return { text: parts.join(' '), tooltip: 'Git 状态' };
    },

    'tokens-input'(ctx) {
        const n = ctx.state.tokenMetrics.inputTokens;
        return { text: `↑${formatTokens(n)}`, tooltip: `输入 Token: ${n.toLocaleString()}` };
    },

    'tokens-output'(ctx) {
        const n = ctx.state.tokenMetrics.outputTokens;
        return { text: `↓${formatTokens(n)}`, tooltip: `输出 Token: ${n.toLocaleString()}` };
    },

    'tokens-cached'(ctx) {
        const n = ctx.state.tokenMetrics.cachedTokens;
        if (n === 0) {
            return null;
        }
        return { text: `⟲${formatTokens(n)}`, tooltip: `缓存 Token: ${n.toLocaleString()}` };
    },

    'tokens-total'(ctx) {
        const n = ctx.state.tokenMetrics.totalTokens;
        return { text: formatTokens(n), tooltip: `总 Token: ${n.toLocaleString()}` };
    },

    cost(ctx) {
        const provider = ctx.state.provider;
        const providerName = provider?.name.toLowerCase() ?? '';
        const envModel = provider?.settingsConfig?.env?.ANTHROPIC_MODEL?.toLowerCase() ??
            (ctx.state.settings?.model ?? 'sonnet').toLowerCase();

        // Rough estimates per MTok. For third-party providers these are just
        // Claude-family proxies; real pricing may differ.
        let inputRate = 3;
        let outputRate = 15;
        let rateLabel = envModel;

        if (envModel.includes('opus')) {
            inputRate = 15;
            outputRate = 75;
        } else if (envModel.includes('haiku')) {
            inputRate = 0.8;
            outputRate = 4;
        } else if (envModel.includes('deepseek') || providerName.includes('deepseek')) {
            inputRate = 0.5;
            outputRate = 2;
            rateLabel = 'deepseek';
        } else if (envModel.includes('kimi') || providerName.includes('kimi')) {
            inputRate = 2;
            outputRate = 8;
            rateLabel = 'kimi';
        }

        const multiplier = provider ? parseFloat(provider.costMultiplier) : 1.0;
        const m = Number.isFinite(multiplier) ? multiplier : 1.0;

        const inputCost = (ctx.state.tokenMetrics.inputTokens / 1_000_000) * inputRate * m;
        const outputCost = (ctx.state.tokenMetrics.outputTokens / 1_000_000) * outputRate * m;
        const cachedCost = (ctx.state.tokenMetrics.cachedTokens / 1_000_000) * (inputRate * 0.1) * m;
        const total = inputCost + outputCost + cachedCost;

        if (total < 0.0001) {
            return { text: '$0.000', tooltip: '预估会话费用' };
        }

        const providerNote = provider ? `\n供应商: ${provider.name}` : '';
        return {
            text: formatCost(total),
            tooltip: `预估会话费用 (按 ${rateLabel} 费率估算)${providerNote}`
        };
    },

    'session-duration'(ctx) {
        const d = ctx.state.sessionDuration;
        if (!d) {
            return null;
        }
        return { text: d, tooltip: '会话持续时间' };
    },

    'context-length'(ctx) {
        const n = ctx.state.tokenMetrics.contextLength;
        return { text: formatTokens(n), tooltip: `上下文长度: ${n.toLocaleString()}` };
    },

    'context-pct'(ctx) {
        // Estimate context window based on model
        const model = (ctx.state.settings?.model ?? 'sonnet').toLowerCase();
        let windowSize = 200_000;
        if (model.includes('1m') || model.includes('1000000')) {
            windowSize = 1_000_000;
        } else if (model.includes('200k') || model.includes('200000')) {
            windowSize = 200_000;
        }

        const used = ctx.state.tokenMetrics.contextLength;
        const pct = windowSize > 0 ? Math.round((used / windowSize) * 100) : 0;
        return { text: `${pct}`, tooltip: `上下文使用: ${used.toLocaleString()} / ${windowSize.toLocaleString()} (${pct}%)` };
    },

    'session-id'(ctx) {
        const id = ctx.state.session?.sessionId;
        if (!id) {
            return null;
        }
        return { text: id.slice(0, 8), tooltip: `会话 ID: ${id}` };
    },

    'cwd'(ctx) {
        const cwd = ctx.state.session?.cwd ?? ctx.workspaceFolder;
        if (!cwd) {
            return null;
        }
        return { text: cwd, tooltip: '当前工作目录' };
    },

    'claude-version'(ctx) {
        const v = ctx.state.session?.version;
        if (!v) {
            return null;
        }
        return { text: v, tooltip: `Claude Code 版本: ${v}` };
    },

    provider(ctx) {
        const p = ctx.state.provider;
        if (!p) {
            return null;
        }
        return { text: p.name, tooltip: `供应商: ${p.name}` };
    }
};

const WIDGET_PATTERN = /\{([a-z0-9-]+)\}/g;

export function renderFormat(format: string, ctx: RenderContext): { text: string; tooltip: string } {
    const tooltips: string[] = [];

    const text = format.replace(WIDGET_PATTERN, (_match, name: string) => {
        const renderer = WIDGETS[name];
        if (!renderer) {
            return `{${name}}`;
        }

        const result = renderer(ctx);
        if (!result) {
            return '';
        }

        if (result.tooltip) {
            tooltips.push(result.tooltip);
        }

        return result.text;
    });

    return {
        text: text.replace(/\| \|/g, '|').replace(/\|$/g, '').trim(),
        tooltip: tooltips.join('\n') || 'Claude Code 状态'
    };
}
