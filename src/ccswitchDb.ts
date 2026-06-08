import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import initSqlJs from 'sql.js';

const CCSWITCH_DB = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

export interface UsageSummary {
    totalRequests: number;
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheCreationTokens: number;
    totalCacheReadTokens: number;
    realTotalTokens: number;
    cacheHitRate: number;
    successRate: number;
}

export interface DailyStats {
    date: string;
    requestCount: number;
    totalCost: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
}

let sqlModule: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSql(): Promise<NonNullable<typeof sqlModule>> {
    if (sqlModule) return sqlModule;
    sqlModule = await initSqlJs();
    return sqlModule;
}

function openDb() {
    if (!fs.existsSync(CCSWITCH_DB)) {
        throw new Error('cc-switch 数据库不存在: ' + CCSWITCH_DB);
    }
    const buf = fs.readFileSync(CCSWITCH_DB);
    return buf;
}

/**
 * fresh_input SQL 表达式
 * 对于 codex/gemini，input_tokens 包含了 cache_read_tokens，需要扣除
 */
function freshInputSql(alias: string = ''): string {
    const p = alias ? `${alias}.` : '';
    return `CASE WHEN ${p}app_type IN ('codex', 'gemini') AND ${p}input_tokens >= ${p}cache_read_tokens THEN (${p}input_tokens - ${p}cache_read_tokens) ELSE ${p}input_tokens END`;
}

export async function getUsageSummary(
    startDate?: Date,
    endDate?: Date,
    appType?: string
): Promise<UsageSummary> {
    const SQL = await getSql();
    const buf = openDb();
    const db = new SQL.Database(buf);

    const startTs = startDate ? Math.floor(startDate.getTime() / 1000) : undefined;
    const endTs = endDate ? Math.floor(endDate.getTime() / 1000) : undefined;

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (startTs !== undefined) {
        conditions.push('created_at >= ?');
        params.push(startTs);
    }
    if (endTs !== undefined) {
        conditions.push('created_at <= ?');
        params.push(endTs);
    }
    if (appType) {
        conditions.push("app_type = ?");
        params.push(appType);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const freshInput = freshInputSql();

    const sql = `
        SELECT
            COUNT(*) as total_requests,
            COALESCE(SUM(CAST(total_cost_usd AS REAL)), 0) as total_cost,
            COALESCE(SUM(${freshInput}), 0) as total_input_tokens,
            COALESCE(SUM(output_tokens), 0) as total_output_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation_tokens,
            COALESCE(SUM(cache_read_tokens), 0) as total_cache_read_tokens,
            COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END), 0) as success_count
        FROM proxy_request_logs
        ${where}
    `;

    const res = db.exec(sql, params);
    db.close();

    if (!res.length || !res[0].values.length) {
        return {
            totalRequests: 0,
            totalCost: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheCreationTokens: 0,
            totalCacheReadTokens: 0,
            realTotalTokens: 0,
            cacheHitRate: 0,
            successRate: 0,
        };
    }

    const row = res[0].values[0];
    const totalRequests = Number(row[0]);
    const totalCost = Number(row[1]);
    const totalInputTokens = Number(row[2]);
    const totalOutputTokens = Number(row[3]);
    const totalCacheCreationTokens = Number(row[4]);
    const totalCacheReadTokens = Number(row[5]);
    const successCount = Number(row[6]);

    const realTotalTokens = totalInputTokens + totalOutputTokens + totalCacheCreationTokens + totalCacheReadTokens;
    const cacheableInput = totalInputTokens + totalCacheCreationTokens + totalCacheReadTokens;
    const cacheHitRate = cacheableInput > 0 ? totalCacheReadTokens / cacheableInput : 0;
    const successRate = totalRequests > 0 ? (successCount / totalRequests) * 100 : 0;

    return {
        totalRequests,
        totalCost,
        totalInputTokens,
        totalOutputTokens,
        totalCacheCreationTokens,
        totalCacheReadTokens,
        realTotalTokens,
        cacheHitRate,
        successRate,
    };
}

export async function getDailyTrends(
    startDate?: Date,
    endDate?: Date,
    appType?: string
): Promise<DailyStats[]> {
    const SQL = await getSql();
    const buf = openDb();
    const db = new SQL.Database(buf);

    const startTs = startDate ? Math.floor(startDate.getTime() / 1000) : undefined;
    const endTs = endDate ? Math.floor(endDate.getTime() / 1000) : undefined;

    const conditions: string[] = ['created_at >= ?', 'created_at <= ?'];
    const params: (string | number)[] = [startTs ?? 0, endTs ?? Math.floor(Date.now() / 1000)];

    if (appType) {
        conditions.push('app_type = ?');
        params.push(appType);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const freshInput = freshInputSql();

    const sql = `
        SELECT
            date(created_at, 'unixepoch', 'localtime') as day,
            COUNT(*) as request_count,
            COALESCE(SUM(CAST(total_cost_usd AS REAL)), 0) as total_cost,
            COALESCE(SUM(${freshInput} + output_tokens), 0) as total_tokens,
            COALESCE(SUM(${freshInput}), 0) as input_tokens,
            COALESCE(SUM(output_tokens), 0) as output_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
            COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens
        FROM proxy_request_logs
        ${where}
        GROUP BY day
        ORDER BY day ASC
    `;

    const res = db.exec(sql, params);
    db.close();

    if (!res.length) return [];

    return res[0].values.map(row => ({
        date: String(row[0]),
        requestCount: Number(row[1]),
        totalCost: Number(row[2]),
        totalTokens: Number(row[3]),
        inputTokens: Number(row[4]),
        outputTokens: Number(row[5]),
        cacheCreationTokens: Number(row[6]),
        cacheReadTokens: Number(row[7]),
    }));
}
