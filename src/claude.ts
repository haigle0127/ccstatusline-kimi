import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
    ClaudeSession,
    ClaudeSettings,
    ClaudeState,
    TokenMetrics
} from './types';
import { getCurrentProvider, readCcSwitchSettings } from './ccswitch';
import { estimateTranscriptCost, readTranscriptUsage, type TranscriptUsageEvent } from './ccswitchDb';

export function getClaudeConfigDir(): string {
    const override = readCcSwitchSettings()?.claudeConfigDir?.trim();
    return override ? override.replace(/^~(?=[\\/])/, os.homedir()) : path.join(os.homedir(), '.claude');
}

function parseJson(data: string): unknown {
    try {
        return JSON.parse(data);
    } catch {
        return null;
    }
}

function readJsonFile<T>(filePath: string): T | null {
    try {
        const parsed = parseJson(fs.readFileSync(filePath, 'utf8'));
        return parsed as T | null;
    } catch {
        return null;
    }
}

function normalizePath(value: string): string {
    return path.normalize(value).toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
}

function pathsOverlap(left: string, right: string): boolean {
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function readClaudeSettings(): ClaudeSettings | null {
    return readJsonFile<ClaudeSettings>(path.join(getClaudeConfigDir(), 'settings.json'));
}

export function findActiveSession(workspaceFolder?: string): ClaudeSession | null {
    try {
        const sessionsDir = path.join(getClaudeConfigDir(), 'sessions');
        const sessions = fs.readdirSync(sessionsDir)
            .filter(file => file.endsWith('.json'))
            .map(file => readJsonFile<ClaudeSession>(path.join(sessionsDir, file)))
            .filter((session): session is ClaudeSession => Boolean(session?.sessionId && session.cwd))
            .sort((a, b) => b.startedAt - a.startedAt);

        if (!workspaceFolder) {
            return sessions[0] ?? null;
        }
        const workspace = normalizePath(workspaceFolder);
        return sessions.find(session => pathsOverlap(workspace, normalizePath(session.cwd))) ?? null;
    } catch {
        return null;
    }
}

function cwdToProjectDir(cwd: string): string {
    return cwd.replace(/[:\\/]/g, '-');
}

function findTranscriptPath(sessionId: string, sessionCwd?: string): string | null {
    const claudeDir = getClaudeConfigDir();
    const candidates: string[] = [];
    try {
        const projectsDir = path.join(claudeDir, 'projects');
        if (sessionCwd && fs.existsSync(projectsDir)) {
            const projectDir = path.join(projectsDir, cwdToProjectDir(sessionCwd));
            const directPath = path.join(projectDir, `${sessionId}.jsonl`);
            if (fs.existsSync(directPath)) {
                candidates.push(directPath);
            } else if (fs.existsSync(projectDir)) {
                for (const file of fs.readdirSync(projectDir)) {
                    if (file.endsWith('.jsonl') && file.includes(sessionId)) {
                        candidates.push(path.join(projectDir, file));
                    }
                }
            }

            if (candidates.length === 0) {
                for (const directory of fs.readdirSync(projectsDir, { withFileTypes: true })) {
                    if (!directory.isDirectory()) {
                        continue;
                    }
                    const dir = path.join(projectsDir, directory.name);
                    for (const file of fs.readdirSync(dir)) {
                        if (file.endsWith('.jsonl') && file.includes(sessionId)) {
                            candidates.push(path.join(dir, file));
                        }
                    }
                }
            }
        }

        const transcriptsDir = path.join(claudeDir, 'transcripts');
        if (fs.existsSync(transcriptsDir)) {
            for (const file of fs.readdirSync(transcriptsDir)) {
                if (file.endsWith('.jsonl') && file.includes(sessionId)) {
                    candidates.push(path.join(transcriptsDir, file));
                }
            }
        }

        return candidates
            .map(candidate => ({ candidate, mtime: fs.statSync(candidate).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime)[0]?.candidate ?? null;
    } catch {
        return null;
    }
}

const transcriptCache = new Map<string, { mtimeMs: number; size: number; events: TranscriptUsageEvent[] }>();

function readCachedTranscript(transcriptPath: string): TranscriptUsageEvent[] {
    try {
        const stat = fs.statSync(transcriptPath);
        const cached = transcriptCache.get(transcriptPath);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            return cached.events;
        }
        const events = readTranscriptUsage(transcriptPath);
        transcriptCache.set(transcriptPath, { mtimeMs: stat.mtimeMs, size: stat.size, events });
        if (transcriptCache.size > 20) {
            const oldest = transcriptCache.keys().next().value;
            if (oldest) {
                transcriptCache.delete(oldest);
            }
        }
        return events;
    } catch {
        return [];
    }
}

function metricsFromEvents(events: TranscriptUsageEvent[]): TokenMetrics {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    for (const event of events) {
        inputTokens += event.inputTokens;
        outputTokens += event.outputTokens;
        cachedTokens += event.cacheReadTokens + event.cacheCreationTokens;
    }

    const latest = events
        .filter(event => !event.isSidechain)
        .sort((a, b) => b.timestamp - a.timestamp)[0];
    const contextLength = latest
        ? latest.inputTokens + latest.cacheReadTokens + latest.cacheCreationTokens + latest.outputTokens
        : 0;

    return {
        inputTokens,
        outputTokens,
        cachedTokens,
        totalTokens: inputTokens + outputTokens + cachedTokens,
        contextLength,
        model: latest?.model
    };
}

export function getTokenMetrics(transcriptPath: string): TokenMetrics {
    return metricsFromEvents(readCachedTranscript(transcriptPath));
}

function formatDuration(start: number, end: number): string | null {
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return null;
    }
    const totalMinutes = Math.max(0, Math.floor((end - start) / 60));
    if (totalMinutes < 1) {
        return '<1m';
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) {
        return `${minutes}m`;
    }
    return minutes === 0 ? `${hours}hr` : `${hours}hr ${minutes}m`;
}

export async function collectClaudeState(workspaceFolder?: string): Promise<ClaudeState> {
    const settings = readClaudeSettings();
    const session = findActiveSession(workspaceFolder);
    const [provider] = await Promise.all([getCurrentProvider('claude')]);

    let tokenMetrics: TokenMetrics = {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        contextLength: 0
    };
    let sessionDuration: string | null = null;
    let transcriptPath: string | null = null;
    let activityAt = session?.startedAt ?? 0;
    let sessionCost: ClaudeState['sessionCost'] = { totalCost: null, unpricedRequests: 0, pricedRequests: 0, multiplier: 1 };

    if (session) {
        transcriptPath = findTranscriptPath(session.sessionId, session.cwd);
        if (transcriptPath) {
            const events = readCachedTranscript(transcriptPath);
            tokenMetrics = metricsFromEvents(events);
            const timestamps = events.map(event => event.timestamp);
            sessionDuration = timestamps.length > 0
                ? formatDuration(Math.min(...timestamps), Math.max(...timestamps))
                : null;
            activityAt = fs.statSync(transcriptPath).mtimeMs;
            const multiplier = Number.parseFloat(provider?.costMultiplier ?? '1');
            const normalizedMultiplier = Number.isFinite(multiplier) ? multiplier : 1;
            sessionCost = {
                ...await estimateTranscriptCost(events, normalizedMultiplier),
                multiplier: normalizedMultiplier
            };
        }
    }

    return {
        session,
        settings,
        provider,
        tokenMetrics,
        speedMetrics: null,
        sessionCost,
        sessionDuration,
        gitInfo: {},
        transcriptPath,
        activityAt,
        updatedAt: Date.now()
    };
}
