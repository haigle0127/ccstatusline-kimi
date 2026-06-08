import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const TRANSCRIPTS_DIR = path.join(CLAUDE_DIR, 'transcripts');

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

interface RawEntry {
    timestamp?: string;
    type?: string;
    message?: {
        usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
        };
    };
}

// Rough cost rates per MTok (Claude Sonnet 4.6)
const INPUT_RATE = 3;
const OUTPUT_RATE = 15;
const CACHE_READ_RATE = 0.3; // 10% of input
const CACHE_CREATION_RATE = 3.75; // 125% of input

function parseJsonlLine(line: string): RawEntry | null {
    try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') {
            return parsed as RawEntry;
        }
    } catch {
        // ignore malformed lines
    }
    return null;
}

function getLocalDateString(isoTimestamp: string): string {
    const d = new Date(isoTimestamp);
    const year = d.getFullYear();
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function estimateCost(
    input: number,
    output: number,
    cacheRead: number,
    cacheCreation: number
): number {
    const inputCost = (input / 1_000_000) * INPUT_RATE;
    const outputCost = (output / 1_000_000) * OUTPUT_RATE;
    const cacheReadCost = (cacheRead / 1_000_000) * CACHE_READ_RATE;
    const cacheCreationCost = (cacheCreation / 1_000_000) * CACHE_CREATION_RATE;
    return inputCost + outputCost + cacheReadCost + cacheCreationCost;
}

function collectTranscriptFiles(): string[] {
    const files: string[] = [];

    // VSCode extension layout: ~/.claude/projects/<project>/<sessionId>.jsonl
    if (fs.existsSync(PROJECTS_DIR)) {
        try {
            const projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => path.join(PROJECTS_DIR, d.name));
            for (const projectDir of projects) {
                try {
                    const entries = fs.readdirSync(projectDir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                            files.push(path.join(projectDir, entry.name));
                        } else if (entry.isDirectory()) {
                            // Handle nested dirs (e.g. subagents)
                            const subDir = path.join(projectDir, entry.name);
                            try {
                                const subFiles = fs.readdirSync(subDir)
                                    .filter(f => f.endsWith('.jsonl'))
                                    .map(f => path.join(subDir, f));
                                files.push(...subFiles);
                            } catch { /* ignore */ }
                        }
                    }
                } catch { /* ignore unreadable dirs */ }
            }
        } catch { /* ignore */ }
    }

    // Legacy CLI layout: ~/.claude/transcripts/<sessionId>.jsonl
    if (fs.existsSync(TRANSCRIPTS_DIR)) {
        try {
            const entries = fs.readdirSync(TRANSCRIPTS_DIR, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                    files.push(path.join(TRANSCRIPTS_DIR, entry.name));
                }
            }
        } catch { /* ignore */ }
    }

    return files;
}

function readTranscriptData(
    filePath: string,
    startDate?: Date,
    endDate?: Date
): Array<{
    date: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    requestCount: number;
}> {
    const result: ReturnType<typeof readTranscriptData> = [];

    const startTs = startDate ? startDate.getTime() : 0;
    const endTs = endDate ? endDate.getTime() : Infinity;

    try {
        const data = fs.readFileSync(filePath, 'utf-8');
        const lines = data.split(/\r?\n/).filter(l => l.trim() !== '');

        for (const line of lines) {
            const entry = parseJsonlLine(line);
            if (!entry || entry.type !== 'assistant') {
                continue;
            }
            const usage = entry.message?.usage;
            if (!usage) {
                continue;
            }

            const timestamp = entry.timestamp;
            if (!timestamp) {
                continue;
            }

            const entryTime = new Date(timestamp).getTime();
            if (Number.isNaN(entryTime) || entryTime < startTs || entryTime > endTs) {
                continue;
            }

            const date = getLocalDateString(timestamp);
            const inputTokens = usage.input_tokens || 0;
            const outputTokens = usage.output_tokens || 0;
            const cacheReadTokens = usage.cache_read_input_tokens || 0;
            const cacheCreationTokens = usage.cache_creation_input_tokens || 0;

            // Check if this is a "real" request (has output tokens)
            if (outputTokens === 0 && inputTokens === 0) {
                continue;
            }

            result.push({
                date,
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheCreationTokens,
                requestCount: 1,
            });
        }
    } catch {
        // ignore unreadable files
    }

    return result;
}

function aggregateByDate(
    entries: Array<{
        date: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        requestCount: number;
    }>
): Map<string, DailyStats> {
    const map = new Map<string, DailyStats>();

    for (const e of entries) {
        const existing = map.get(e.date);
        if (existing) {
            existing.requestCount += e.requestCount;
            existing.inputTokens += e.inputTokens;
            existing.outputTokens += e.outputTokens;
            existing.cacheCreationTokens += e.cacheCreationTokens;
            existing.cacheReadTokens += e.cacheReadTokens;
        } else {
            map.set(e.date, {
                date: e.date,
                requestCount: e.requestCount,
                inputTokens: e.inputTokens,
                outputTokens: e.outputTokens,
                cacheCreationTokens: e.cacheCreationTokens,
                cacheReadTokens: e.cacheReadTokens,
                totalTokens: 0,
                totalCost: 0,
            });
        }
    }

    // Compute derived fields
    for (const stats of map.values()) {
        stats.totalTokens = stats.inputTokens + stats.outputTokens + stats.cacheCreationTokens + stats.cacheReadTokens;
        stats.totalCost = estimateCost(
            stats.inputTokens,
            stats.outputTokens,
            stats.cacheReadTokens,
            stats.cacheCreationTokens
        );
    }

    return map;
}

function getAllEntries(startDate?: Date, endDate?: Date): ReturnType<typeof readTranscriptData> {
    const files = collectTranscriptFiles();
    const allEntries: ReturnType<typeof readTranscriptData> = [];

    for (const file of files) {
        const entries = readTranscriptData(file, startDate, endDate);
        allEntries.push(...entries);
    }

    return allEntries;
}

export async function getUsageSummary(
    startDate?: Date,
    endDate?: Date,
    _appType?: string
): Promise<UsageSummary> {
    const entries = getAllEntries(startDate, endDate);

    let totalRequests = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;

    for (const e of entries) {
        totalRequests += e.requestCount;
        totalInputTokens += e.inputTokens;
        totalOutputTokens += e.outputTokens;
        totalCacheCreationTokens += e.cacheCreationTokens;
        totalCacheReadTokens += e.cacheReadTokens;
    }

    const realTotalTokens = totalInputTokens + totalOutputTokens + totalCacheCreationTokens + totalCacheReadTokens;
    const cacheableInput = totalInputTokens + totalCacheCreationTokens + totalCacheReadTokens;
    const cacheHitRate = cacheableInput > 0 ? totalCacheReadTokens / cacheableInput : 0;
    const totalCost = estimateCost(totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens);

    return {
        totalRequests,
        totalCost,
        totalInputTokens,
        totalOutputTokens,
        totalCacheCreationTokens,
        totalCacheReadTokens,
        realTotalTokens,
        cacheHitRate,
        successRate: 100, // transcript only contains successful requests
    };
}

export async function getDailyTrends(
    startDate?: Date,
    endDate?: Date,
    _appType?: string
): Promise<DailyStats[]> {
    const entries = getAllEntries(startDate, endDate);
    const map = aggregateByDate(entries);

    const sorted = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
    return sorted;
}
