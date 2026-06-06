export interface ClaudeSession {
    pid: number;
    sessionId: string;
    cwd: string;
    startedAt: number;
    procStart: string;
    version: string;
    peerProtocol: number;
    kind: string;
    entrypoint: string;
}

export interface ClaudeSettings {
    env?: Record<string, string>;
    theme?: string;
    hasCompletedOnboarding?: boolean;
    telemetryEnabled?: boolean;
    model?: string;
    effortLevel?: string;
    permissions?: { allow?: string[] };
}

export interface TranscriptUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

export interface TranscriptMessage {
    usage?: TranscriptUsage;
    stop_reason?: string | null;
}

export interface TranscriptLine {
    type?: string;
    timestamp?: string;
    agentId?: string;
    isSidechain?: boolean;
    isApiErrorMessage?: boolean;
    message?: TranscriptMessage;
    content?: unknown;
}

export interface TokenMetrics {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    totalTokens: number;
    contextLength: number;
}

export interface SpeedMetrics {
    totalDurationMs: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requestCount: number;
}

export interface GitInfo {
    branch?: string;
    ahead?: number;
    behind?: number;
    changes?: number;
    insertions?: number;
    deletions?: number;
    staged?: number;
    unstaged?: number;
    untracked?: number;
    conflicts?: number;
    isClean?: boolean;
}

export interface CcSwitchProvider {
    id: string;
    appType: string;
    name: string;
    settingsConfig: {
        env?: Record<string, string>;
        theme?: string;
    };
    category?: string;
    icon?: string;
    iconColor?: string;
    meta?: Record<string, unknown>;
    isCurrent: boolean;
    costMultiplier: string;
    providerType?: string;
}

export interface ClaudeState {
    session: ClaudeSession | null;
    settings: ClaudeSettings | null;
    provider: CcSwitchProvider | null;
    tokenMetrics: TokenMetrics;
    speedMetrics: SpeedMetrics | null;
    sessionDuration: string | null;
    gitInfo: GitInfo;
    updatedAt: number;
}

export interface RenderContext {
    state: ClaudeState;
    workspaceFolder: string | undefined;
}

export interface WidgetResult {
    text: string;
    tooltip?: string;
    command?: string;
}

export type WidgetRenderer = (ctx: RenderContext) => WidgetResult | null;
