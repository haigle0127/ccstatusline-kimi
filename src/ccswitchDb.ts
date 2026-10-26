import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readCcSwitchSettings } from './ccswitch';
import { numberValue, queryCcSwitch, stringValue } from './sqlite';
import {
    aggregateUsage,
    localDateKey,
    type AggregatedUsage,
    type ModelPricing,
    type UsageBuckets,
    type UsageRecord,
    type UsageSummary,
    type TrendStats,
} from './usageMath';

export type { UsageSummary, ModelStats, ProviderStats } from './usageMath';
export type DailyStats = TrendStats;
export type UsageSource = 'cc-switch' | 'transcript' | 'empty';

export interface UsageDashboardData extends AggregatedUsage {
    source: UsageSource;
    sourceLabel: string;
    isHourly: boolean;
    generatedAt: number;
    startDate: number;
    endDate: number;
}

export interface UsageRange {
    preset: string;
    start: Date;
    end: Date;
}

export interface TranscriptUsageEvent {
    messageId: string;
    timestamp: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheCreation1hTokens: number;
    cacheReadTokens: number;
    isSidechain: boolean;
    stopReason: string | null;
}

let pricingCache: { loadedAt: number; values: Map<string, ModelPricing> } | null = null;

export async function getModelPricing(force = false): Promise<ReadonlyMap<string, ModelPricing>> {
    if (!force && pricingCache && Date.now() - pricingCache.loadedAt < 30_000) {
        return pricingCache.values;
    }
    try {
        const rows = await queryCcSwitch(`SELECT model_id, input_cost_per_million, output_cost_per_million,
            cache_read_cost_per_million, cache_creation_cost_per_million FROM model_pricing`);
        const values = new Map<string, ModelPricing>();
        for (const row of rows) {
            const modelId = stringValue(row.model_id).toLowerCase();
            if (!modelId) {
                continue;
            }
            values.set(modelId, {
                modelId,
                input: numberValue(row.input_cost_per_million),
                output: numberValue(row.output_cost_per_million),
                cacheRead: numberValue(row.cache_read_cost_per_million),
                cacheCreation: numberValue(row.cache_creation_cost_per_million)
            });
        }
        pricingCache = { loadedAt: Date.now(), values };
        return values;
    } catch {
        return pricingCache?.values ?? new Map();
    }
}

function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function getDateRangePreset(preset: string, now = new Date()): UsageRange {
    const today = startOfDay(now);
    let start = today;
    let end = now;
    switch (preset) {
        case 'yesterday':
            start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
            end = new Date(today.getTime() - 1);
            break;
        case 'week': {
            const day = today.getDay() || 7;
            start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - day + 1);
            break;
        }
        case '30d':
            start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29);
            break;
        case 'month':
            start = new Date(today.getFullYear(), today.getMonth(), 1);
            break;
        case '7d':
            start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
            break;
        case 'today':
        default:
            preset = 'today';
            break;
    }
    return { preset, start, end };
}

function hourKey(timestamp: number): string {
    const value = new Date(timestamp * 1000);
    return new Date(value.getFullYear(), value.getMonth(), value.getDate(), value.getHours()).toISOString();
}

function buildBuckets(range: UsageRange): { buckets: UsageBuckets[]; isHourly: boolean } {
    const isHourly = range.preset === 'today' || range.preset === 'yesterday';
    // Custom/all-time ranges derive buckets from returned records instead of
    // allocating one entry per day since 1970.
    if (range.preset === 'custom') {
        return { buckets: [], isHourly };
    }
    if (isHourly) {
        const buckets: UsageBuckets[] = [];
        const cursor = startOfDay(range.start);
        while (cursor <= range.end) {
            buckets.push({ key: cursor.toISOString(), date: cursor.toISOString() });
            cursor.setHours(cursor.getHours() + 1);
        }
        return { buckets, isHourly };
    }

    const buckets: UsageBuckets[] = [];
    const cursor = startOfDay(range.start);
    const last = startOfDay(range.end);
    while (cursor <= last) {
        const key = localDateKey(cursor.getTime() / 1000);
        buckets.push({ key, date: cursor.toISOString() });
        cursor.setDate(cursor.getDate() + 1);
    }
    return { buckets, isHourly };
}

function bucketsForRecords(range: UsageRange, buckets: UsageBuckets[], records: UsageRecord[]): UsageBuckets[] {
    if (range.preset !== 'custom') {
        return buckets;
    }
    const keys = Array.from(new Set(records.map(record => record.date ?? localDateKey(record.timestamp)))).sort();
    return keys.map(key => ({ key, date: new Date(`${key}T00:00:00`).toISOString() }));
}

function freshInput(row: { appType: string; semantics: number; input: number; cacheRead: number; cacheCreation: number }): number {
    if (row.semantics === 2 || !['codex', 'gemini', 'grokbuild'].includes(row.appType)) {
        return row.input;
    }
    if (row.semantics === 1 && row.input >= row.cacheRead + row.cacheCreation) {
        return row.input - row.cacheRead - row.cacheCreation;
    }
    if (row.semantics === 0 && row.input >= row.cacheRead) {
        return row.input - row.cacheRead;
    }
    return row.input;
}

// Mirrors cc-switch's session/proxy fingerprint deduplication for Claude logs.
const EFFECTIVE_CLAUDE_LOG = `NOT (
    COALESCE(l.data_source, 'proxy') = 'session_log' AND EXISTS (
        SELECT 1 FROM proxy_request_logs d
        WHERE COALESCE(d.data_source, 'proxy') = 'proxy'
          AND d.app_type IN (l.app_type, CASE WHEN l.app_type = 'claude-desktop' THEN 'claude' ELSE l.app_type END)
          AND d.status_code >= 200 AND d.status_code < 300
          AND d.input_tokens = l.input_tokens
          AND d.output_tokens = l.output_tokens
          AND d.cache_read_tokens = l.cache_read_tokens
          AND d.cache_creation_tokens = l.cache_creation_tokens
          AND d.created_at BETWEEN l.created_at - 600 AND l.created_at + 600
          AND (LOWER(d.model) = LOWER(l.model) OR LOWER(d.model) = 'unknown' OR LOWER(l.model) = 'unknown')
    )
)`;

async function readCcSwitchRecords(range: UsageRange, isHourly: boolean): Promise<UsageRecord[]> {
    const start = Math.floor(range.start.getTime() / 1000);
    const end = Math.floor(range.end.getTime() / 1000);
    const rows = await queryCcSwitch(`SELECT l.created_at, l.app_type, l.input_token_semantics,
        l.input_tokens, l.output_tokens, l.cache_creation_tokens, l.cache_read_tokens,
        l.total_cost_usd, l.cost_multiplier, l.status_code,
        COALESCE(NULLIF(l.pricing_model, ''), l.model) AS effective_model,
        COALESCE(p.name, CASE l.provider_id WHEN '_session' THEN 'Claude（会话）' ELSE l.provider_id END) AS provider_name
        FROM proxy_request_logs l
        LEFT JOIN providers p ON l.provider_id = p.id AND l.app_type = p.app_type
        WHERE l.created_at >= ? AND l.created_at <= ?
          AND l.app_type IN ('claude', 'claude-desktop') AND ${EFFECTIVE_CLAUDE_LOG}`, [start, end]);

    const records: UsageRecord[] = rows.map(row => {
        const input = numberValue(row.input_tokens);
        const cacheRead = numberValue(row.cache_read_tokens);
        const cacheCreation = numberValue(row.cache_creation_tokens);
        const timestamp = numberValue(row.created_at);
        return {
            timestamp,
            date: isHourly ? hourKey(timestamp) : localDateKey(timestamp),
            requestCount: 1,
            providerName: stringValue(row.provider_name, '未知供应商'),
            model: stringValue(row.effective_model, 'unknown'),
            inputTokens: freshInput({
                appType: stringValue(row.app_type), semantics: numberValue(row.input_token_semantics),
                input, cacheRead, cacheCreation
            }),
            outputTokens: numberValue(row.output_tokens),
            cacheCreationTokens: cacheCreation,
            cacheReadTokens: cacheRead,
            totalCost: numberValue(row.total_cost_usd),
            costMultiplier: numberValue(row.cost_multiplier, 1),
            statusCode: numberValue(row.status_code)
        } satisfies UsageRecord;
    });

    if (isHourly) {
        return records;
    }

    // Daily rollups contain records whose old detail rows were pruned. Only full
    // local days inside the selected range are eligible, matching cc-switch.
    const startDay = startOfDay(range.start);
    const endDay = startOfDay(range.end);
    const rollupStart = range.start.getTime() === startDay.getTime()
        ? startDay : new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + 1);
    const isFullEndDay = range.end.getHours() === 23 && range.end.getMinutes() === 59;
    const rollupEnd = isFullEndDay ? endDay : new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() - 1);
    if (rollupStart > rollupEnd) {
        return records;
    }

    const rollupRows = await queryCcSwitch(`SELECT r.date, r.app_type, r.input_token_semantics,
        r.request_count, r.success_count, r.input_tokens, r.output_tokens,
        r.cache_creation_tokens, r.cache_read_tokens, r.total_cost_usd,
        COALESCE(NULLIF(r.pricing_model, ''), r.model) AS effective_model,
        COALESCE(p.name, CASE r.provider_id WHEN '_session' THEN 'Claude（会话）' ELSE r.provider_id END) AS provider_name
        FROM usage_daily_rollups r
        LEFT JOIN providers p ON r.provider_id = p.id AND r.app_type = p.app_type
        WHERE r.date >= ? AND r.date <= ? AND r.app_type IN ('claude', 'claude-desktop')`,
    [localDateKey(rollupStart.getTime() / 1000), localDateKey(rollupEnd.getTime() / 1000)]);

    for (const row of rollupRows) {
        const date = stringValue(row.date);
        const input = numberValue(row.input_tokens);
        const cacheRead = numberValue(row.cache_read_tokens);
        const cacheCreation = numberValue(row.cache_creation_tokens);
        records.push({
            timestamp: new Date(`${date}T00:00:00`).getTime() / 1000,
            date,
            requestCount: numberValue(row.request_count),
            successCount: numberValue(row.success_count),
            providerName: stringValue(row.provider_name, '未知供应商'),
            model: stringValue(row.effective_model, 'unknown'),
            inputTokens: freshInput({
                appType: stringValue(row.app_type), semantics: numberValue(row.input_token_semantics),
                input, cacheRead, cacheCreation
            }),
            outputTokens: numberValue(row.output_tokens),
            cacheCreationTokens: cacheCreation,
            cacheReadTokens: cacheRead,
            totalCost: numberValue(row.total_cost_usd),
            costMultiplier: 1,
            statusCode: 200
        });
    }
    return records;
}

function numeric(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function readTranscriptUsage(filePath: string): TranscriptUsageEvent[] {
    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch {
        return [];
    }

    const messages = new Map<string, TranscriptUsageEvent>();
    for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) {
            continue;
        }
        try {
            const entry = JSON.parse(line) as {
                type?: string; timestamp?: string; isSidechain?: boolean; isApiErrorMessage?: boolean;
                message?: {
                    id?: string; model?: string; stop_reason?: string | null;
                    usage?: Record<string, unknown> & { cache_creation?: Record<string, unknown> };
                };
            };
            if (entry.type !== 'assistant' || entry.isApiErrorMessage || !entry.message?.usage || !entry.message.id) {
                continue;
            }
            const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : NaN;
            if (!Number.isFinite(timestamp)) {
                continue;
            }
            const usage = entry.message.usage;
            const event: TranscriptUsageEvent = {
                messageId: entry.message.id,
                timestamp: timestamp / 1000,
                model: entry.message.model ?? 'unknown',
                inputTokens: numeric(usage.input_tokens),
                outputTokens: numeric(usage.output_tokens),
                cacheCreationTokens: numeric(usage.cache_creation_input_tokens),
                cacheCreation1hTokens: numeric(usage.cache_creation?.ephemeral_1h_input_tokens),
                cacheReadTokens: numeric(usage.cache_read_input_tokens),
                isSidechain: entry.isSidechain === true,
                stopReason: typeof entry.message.stop_reason === 'string' ? entry.message.stop_reason : null
            };
            const previous = messages.get(event.messageId);
            const shouldReplace = !previous
                || (event.stopReason !== null && previous.stopReason === null)
                || (event.stopReason !== null === (previous.stopReason !== null) && event.outputTokens > previous.outputTokens);
            if (shouldReplace) {
                messages.set(event.messageId, event);
            }
        } catch {
            // A partially-written final line is ignored until the next refresh.
        }
    }
    return Array.from(messages.values()).filter(event =>
        event.inputTokens + event.outputTokens + event.cacheCreationTokens + event.cacheReadTokens > 0
    );
}

function transcriptRecord(event: TranscriptUsageEvent, isHourly: boolean): UsageRecord {
    return {
        timestamp: event.timestamp,
        date: isHourly ? hourKey(event.timestamp) : localDateKey(event.timestamp),
        requestCount: 1,
        providerName: 'Claude（本地会话）',
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheCreationTokens: event.cacheCreationTokens,
        cacheCreation1hTokens: event.cacheCreation1hTokens,
        cacheReadTokens: event.cacheReadTokens,
        totalCost: 0,
        costMultiplier: 1,
        statusCode: 200
    };
}

function collectTranscriptFiles(root: string, depth = 0): string[] {
    if (depth > 6) {
        return [];
    }
    try {
        const files: string[] = [];
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            const target = path.join(root, entry.name);
            if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                files.push(target);
            } else if (entry.isDirectory()) {
                files.push(...collectTranscriptFiles(target, depth + 1));
            }
        }
        return files;
    } catch {
        return [];
    }
}

async function getClaudeProjectsDir(): Promise<string> {
    const override = readCcSwitchSettings()?.claudeConfigDir?.trim();
    const claudeDir = override
        ? override.replace(/^~(?=[\\/])/, os.homedir())
        : path.join(os.homedir(), '.claude');
    return path.join(claudeDir, 'projects');
}

function emptyUsage(range: UsageRange, generatedAt: number): UsageDashboardData {
    const startDate = range.start.getTime();
    const endDate = range.end.getTime();
    return {
        summary: {
            totalRequests: 0, totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0,
            totalCacheCreationTokens: 0, totalCacheReadTokens: 0, realTotalTokens: 0,
            cacheHitRate: null, successRate: null, unpricedRequests: 0, estimatedCostRequests: 0
        },
        trends: [], models: [], providers: [], source: 'empty', sourceLabel: '暂无本地用量记录',
        isHourly: range.preset === 'today' || range.preset === 'yesterday',
        generatedAt, startDate, endDate
    };
}

export async function getUsageDashboard(range: UsageRange): Promise<UsageDashboardData> {
    const { buckets, isHourly } = buildBuckets(range);
    const pricing = await getModelPricing();
    const common = {
        isHourly,
        generatedAt: Date.now(),
        startDate: range.start.getTime(),
        endDate: range.end.getTime()
    };

    try {
        const records = await readCcSwitchRecords(range, isHourly);
        if (records.length > 0) {
            return {
                ...aggregateUsage(records, pricing, bucketsForRecords(range, buckets, records)),
                ...common,
                source: 'cc-switch',
                sourceLabel: 'CC Switch 数据库'
            };
        }
    } catch (error) {
        console.warn('[ccstatusline] CC Switch usage unavailable, using transcripts:', error);
    }

    const projectsDir = await getClaudeProjectsDir();
    const start = range.start.getTime() / 1000;
    const end = range.end.getTime() / 1000;
    const records: UsageRecord[] = [];
    for (const file of collectTranscriptFiles(projectsDir)) {
        for (const event of readTranscriptUsage(file)) {
            if (event.timestamp >= start && event.timestamp <= end) {
                records.push(transcriptRecord(event, isHourly));
            }
        }
    }
    if (records.length === 0) {
        return emptyUsage(range, common.generatedAt);
    }

    return {
        ...aggregateUsage(records, pricing, bucketsForRecords(range, buckets, records), false),
        ...common,
        source: 'transcript',
        sourceLabel: 'Claude 本地会话'
    };
}

export async function estimateTranscriptCost(events: TranscriptUsageEvent[], costMultiplier = 1): Promise<{
    totalCost: number | null; unpricedRequests: number; pricedRequests: number;
}> {
    const pricing = await getModelPricing();
    const records = events.map(event => ({ ...transcriptRecord(event, false), costMultiplier }));
    const result = aggregateUsage(records, pricing, []).summary;
    const knownZeroCostRequests = costMultiplier === 0 ? records.length : 0;
    return {
        totalCost: result.estimatedCostRequests > 0 || knownZeroCostRequests > 0 ? result.totalCost : null,
        unpricedRequests: result.unpricedRequests,
        pricedRequests: result.estimatedCostRequests + knownZeroCostRequests
    };
}

export async function getUsageSummary(startDate?: Date, endDate?: Date): Promise<UsageSummary> {
    const now = new Date();
    const range: UsageRange = {
        preset: 'custom',
        start: startDate ?? new Date(0),
        end: endDate ?? now
    };
    return (await getUsageDashboard(range)).summary;
}

export async function getDailyTrends(startDate?: Date, endDate?: Date): Promise<DailyStats[]> {
    const now = new Date();
    const range: UsageRange = {
        preset: 'custom',
        start: startDate ?? new Date(0),
        end: endDate ?? now
    };
    return (await getUsageDashboard(range)).trends;
}
