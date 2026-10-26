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
    // The latest main-chain response is the actual routed model. Provider and
    // Claude settings only describe the next request until a response arrives.
    const recordedModel = ctx.state.tokenMetrics.model?.trim();
    if (recordedModel) {
        return recordedModel;
    }

    const provider = ctx.state.provider;
    const envModel = provider?.settingsConfig?.env?.ANTHROPIC_MODEL?.trim();
    if (envModel) {
        return envModel;
    }
    if (ctx.state.settings?.model) {
        return resolveClaudeModelName(ctx.state.settings);
    }
    return provider?.name ?? resolveClaudeModelName(ctx.state.settings);
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

export const WIDGETS: Record<string, (ctx: RenderContext) => WidgetResult | null> = {
    model(ctx) {
        const name = resolveModelName(ctx);
        const provider = ctx.state.provider;
        const source = ctx.state.tokenMetrics.model ? '最近一次主链响应' : '当前供应商／Claude 配置';
        const tooltip = provider
            ? `模型: ${name}\n来源: ${source}\n供应商: ${provider.name}`
            : `Claude 模型: ${name}\n来源: ${source}`;
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
        const { totalCost, unpricedRequests, pricedRequests, multiplier } = ctx.state.sessionCost;
        if (ctx.state.tokenMetrics.totalTokens === 0) {
            return { text: '$0.000', tooltip: '当前会话还没有 Token 用量' };
        }
        if (totalCost === null) {
            return {
                text: '—',
                tooltip: '会话费用未定价\n请在 CC Switch 的模型定价中补充当前模型价格'
            };
        }

        const partial = unpricedRequests > 0 ? `\n${unpricedRequests} 条请求缺少定价，金额仅包含已定价部分` : '';
        const providerNote = ctx.state.provider ? `\n供应商: ${ctx.state.provider.name}` : '';
        return {
            text: `${formatCost(totalCost)}${unpricedRequests > 0 ? '*' : ''}`,
            tooltip: `预估会话费用（按 CC Switch 模型定价，非供应商账单）\n已计价请求: ${pricedRequests}\n成本倍率: ${multiplier}${providerNote}${partial}`
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
        const model = ctx.state.tokenMetrics.model;
        return {
            text: formatTokens(n),
            tooltip: `最近请求上下文估算: ${n.toLocaleString()} tokens（含本轮输出）${model ? `\n记录模型: ${model}` : ''}`
        };
    },

    'context-pct'(ctx) {
        const env = ctx.state.provider?.settingsConfig?.env ?? {};
        const configuredWindow = Number(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
        const model = (ctx.state.tokenMetrics.model ?? env.ANTHROPIC_MODEL ?? ctx.state.settings?.model ?? '').toLowerCase();
        let windowSize = Number.isFinite(configuredWindow) && configuredWindow > 0 ? configuredWindow : 200_000;
        if (!configuredWindow && (model.includes('1m') || model.includes('1000000'))) {
            windowSize = 1_000_000;
        } else if (!configuredWindow && model.includes('256k')) {
            windowSize = 256_000;
        }

        const used = ctx.state.tokenMetrics.contextLength;
        const pct = windowSize > 0 ? Math.round((used / windowSize) * 100) : 0;
        return {
            text: `${pct}%`,
            tooltip: `上下文使用估算: ${used.toLocaleString()} / ${windowSize.toLocaleString()} (${pct}%)${configuredWindow ? '\n窗口来自 CC Switch 供应商配置' : '\n窗口按模型默认值估算'}`
        };
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
