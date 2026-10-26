export interface ModelPricing {
    modelId: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
}

export interface UsageRecord {
    timestamp: number;
    date?: string;
    requestCount: number;
    providerName: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheCreation1hTokens?: number;
    cacheReadTokens: number;
    totalCost: number;
    costMultiplier: number;
    statusCode: number;
    successCount?: number;
}

export interface UsageSummary {
    totalRequests: number;
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheCreationTokens: number;
    totalCacheReadTokens: number;
    realTotalTokens: number;
    cacheHitRate: number | null;
    successRate: number | null;
    unpricedRequests: number;
    estimatedCostRequests: number;
}

export interface TrendStats {
    date: string;
    requestCount: number;
    totalCost: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    cacheHitRate: number | null;
    unpricedRequests: number;
}

export interface ModelStats {
    model: string;
    requestCount: number;
    totalTokens: number;
    totalCost: number;
    unpricedRequests: number;
}

export interface ProviderStats {
    providerName: string;
    requestCount: number;
    totalTokens: number;
    totalCost: number;
    successRate: number | null;
    unpricedRequests: number;
}

export interface UsageBuckets {
    key: string;
    date: string;
}

export interface AggregatedUsage {
    summary: UsageSummary;
    trends: TrendStats[];
    models: ModelStats[];
    providers: ProviderStats[];
}

interface AggregateBucket {
    requests: number;
    cost: number;
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
    success: number;
    unpriced: number;
    estimated: number;
}

function emptyBucket(): AggregateBucket {
    return { requests: 0, cost: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, success: 0, unpriced: 0, estimated: 0 };
}

export function localDateKey(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function normalizeModelForPricing(model: string): string[] {
    const cleaned = model.trim().toLowerCase()
        .replace(/^.*\//, '')
        .split(':')[0]
        .replace(/@/g, '-')
        .replace(/\[1m\]$/g, '');
    if (!cleaned || /^(unknown|null|none)$/.test(cleaned)) {
        return [];
    }

    const candidates: string[] = [];
    const add = (value: string) => {
        const normalized = value.trim();
        if (normalized && !candidates.includes(normalized) && candidates.length < 32) {
            candidates.push(normalized);
        }
    };
    add(cleaned);
    // Apply variants transitively: a model may combine dots, a provider
    // namespace, a date, and a context suffix (for example k3.1-256k).
    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        add(candidate.replace(/\./g, '-'));
        add(candidate.replace(/[.-](?:\d+k|\d+m)$/i, ''));
        add(candidate.replace(/-(?:\d{8}|\d{6}|\d{4}-\d{2}-\d{2})$/i, ''));
        const claudeIndex = candidate.lastIndexOf('claude-');
        if (claudeIndex > 0) {
            add(candidate.slice(claudeIndex));
        }
    }
    return candidates;
}

export function findModelPricing(model: string, pricing: ReadonlyMap<string, ModelPricing>): ModelPricing | null {
    for (const candidate of normalizeModelForPricing(model)) {
        const exact = pricing.get(candidate);
        if (exact) {
            return exact;
        }
    }
    return null;
}

function recordCost(record: UsageRecord, pricing: ReadonlyMap<string, ModelPricing>): { cost: number; unpriced: boolean; estimated: boolean } {
    const hasTokens = record.inputTokens + record.outputTokens + record.cacheCreationTokens + record.cacheReadTokens > 0;
    const successful = record.statusCode >= 200 && record.statusCode < 300;
    if (record.totalCost !== 0 || !successful || !hasTokens || record.costMultiplier === 0) {
        return { cost: record.totalCost, unpriced: false, estimated: false };
    }

    const price = findModelPricing(record.model, pricing);
    if (!price) {
        return { cost: 0, unpriced: true, estimated: false };
    }

    const cache1h = Math.min(record.cacheCreation1hTokens ?? 0, record.cacheCreationTokens);
    const cost = (
        record.inputTokens * price.input
        + record.outputTokens * price.output
        + record.cacheReadTokens * price.cacheRead
        + ((record.cacheCreationTokens - cache1h) + cache1h * 1.6) * price.cacheCreation
    ) / 1_000_000 * record.costMultiplier;
    return { cost, unpriced: false, estimated: true };
}

function addRecord(bucket: AggregateBucket, record: UsageRecord, pricing: ReadonlyMap<string, ModelPricing>): void {
    const cost = recordCost(record, pricing);
    bucket.requests += record.requestCount;
    bucket.cost += cost.cost;
    bucket.input += record.inputTokens;
    bucket.output += record.outputTokens;
    bucket.cacheCreation += record.cacheCreationTokens;
    bucket.cacheRead += record.cacheReadTokens;
    bucket.success += record.successCount ?? (record.statusCode >= 200 && record.statusCode < 300 ? record.requestCount : 0);
    bucket.unpriced += cost.unpriced ? record.requestCount : 0;
    bucket.estimated += cost.estimated ? record.requestCount : 0;
}

function mergeBucket(target: AggregateBucket, source: AggregateBucket): void {
    target.requests += source.requests;
    target.cost += source.cost;
    target.input += source.input;
    target.output += source.output;
    target.cacheCreation += source.cacheCreation;
    target.cacheRead += source.cacheRead;
    target.success += source.success;
    target.unpriced += source.unpriced;
    target.estimated += source.estimated;
}

function tokensOf(bucket: AggregateBucket): number {
    return bucket.input + bucket.output + bucket.cacheCreation + bucket.cacheRead;
}

function hitRateOf(bucket: AggregateBucket): number | null {
    const input = bucket.input + bucket.cacheCreation + bucket.cacheRead;
    return input > 0 ? bucket.cacheRead / input * 100 : null;
}

export function aggregateUsage(
    records: UsageRecord[],
    pricing: ReadonlyMap<string, ModelPricing>,
    buckets: UsageBuckets[],
    includeSuccessRate = true
): AggregatedUsage {
    const total = emptyBucket();
    const trendMap = new Map(buckets.map(bucket => [bucket.key, emptyBucket()]));
    const modelMap = new Map<string, AggregateBucket>();
    const providerMap = new Map<string, AggregateBucket>();

    for (const record of records) {
        addRecord(total, record, pricing);
        const key = record.date ?? localDateKey(record.timestamp);
        const trend = trendMap.get(key);
        if (trend) {
            addRecord(trend, record, pricing);
        }

        const model = record.model || 'unknown';
        const modelBucket = modelMap.get(model) ?? emptyBucket();
        addRecord(modelBucket, record, pricing);
        modelMap.set(model, modelBucket);

        const provider = record.providerName || '未知供应商';
        const providerBucket = providerMap.get(provider) ?? emptyBucket();
        addRecord(providerBucket, record, pricing);
        providerMap.set(provider, providerBucket);
    }

    const trends = buckets.map(bucket => {
        const stats = trendMap.get(bucket.key) ?? emptyBucket();
        return {
            date: bucket.date,
            requestCount: stats.requests,
            totalCost: stats.cost,
            totalTokens: tokensOf(stats),
            inputTokens: stats.input,
            outputTokens: stats.output,
            cacheCreationTokens: stats.cacheCreation,
            cacheReadTokens: stats.cacheRead,
            cacheHitRate: hitRateOf(stats),
            unpricedRequests: stats.unpriced
        };
    });

    const models = Array.from(modelMap, ([model, stats]) => ({
        model,
        requestCount: stats.requests,
        totalTokens: tokensOf(stats),
        totalCost: stats.cost,
        unpricedRequests: stats.unpriced
    })).sort((a, b) => b.totalTokens - a.totalTokens);

    const providers = Array.from(providerMap, ([providerName, stats]) => ({
        providerName,
        requestCount: stats.requests,
        totalTokens: tokensOf(stats),
        totalCost: stats.cost,
        successRate: includeSuccessRate && stats.requests > 0 ? stats.success / stats.requests * 100 : null,
        unpricedRequests: stats.unpriced
    })).sort((a, b) => b.totalTokens - a.totalTokens);

    return {
        summary: {
            totalRequests: total.requests,
            totalCost: total.cost,
            totalInputTokens: total.input,
            totalOutputTokens: total.output,
            totalCacheCreationTokens: total.cacheCreation,
            totalCacheReadTokens: total.cacheRead,
            realTotalTokens: tokensOf(total),
            cacheHitRate: hitRateOf(total),
            successRate: includeSuccessRate && total.requests > 0 ? total.success / total.requests * 100 : null,
            unpricedRequests: total.unpriced,
            estimatedCostRequests: total.estimated
        },
        trends,
        models,
        providers
    };
}
