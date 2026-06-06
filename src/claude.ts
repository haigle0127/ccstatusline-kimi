import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
    ClaudeSession,
    ClaudeSettings,
    ClaudeState,
    SpeedMetrics,
    TokenMetrics,
    TranscriptLine
} from './types';
import { getCurrentProvider } from './ccswitch';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const TRANSCRIPTS_DIR = path.join(CLAUDE_DIR, 'transcripts');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');

function parseJson(data: string): unknown {
    try {
        return JSON.parse(data);
    } catch {
        return null;
    }
}

function readJsonFile<T>(filePath: string): T | null {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        const data = fs.readFileSync(filePath, 'utf-8');
        return parseJson(data) as T | null;
    } catch {
        return null;
    }
}

function readJsonlFile(filePath: string): string[] {
    try {
        if (!fs.existsSync(filePath)) {
            return [];
        }
        const data = fs.readFileSync(filePath, 'utf-8');
        return data.split(/\r?\n/).filter(line => line.trim() !== '');
    } catch {
        return [];
    }
}

function parseJsonlLine(line: string): TranscriptLine | null {
    const parsed = parseJson(line);
    if (parsed && typeof parsed === 'object') {
        return parsed as TranscriptLine;
    }
    return null;
}

function normalizePath(p: string): string {
    return path.normalize(p).toLowerCase().replace(/\\/g, '/');
}

export function readClaudeSettings(): ClaudeSettings | null {
    return readJsonFile<ClaudeSettings>(SETTINGS_PATH);
}

export function findActiveSession(workspaceFolder?: string): ClaudeSession | null {
    try {
        if (!fs.existsSync(SESSIONS_DIR)) {
            return null;
        }

        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
        const sessions: ClaudeSession[] = [];

        for (const file of files) {
            const session = readJsonFile<ClaudeSession>(path.join(SESSIONS_DIR, file));
            if (session) {
                sessions.push(session);
            }
        }

        if (sessions.length === 0) {
            return null;
        }

        // Sort by startedAt desc (most recent first)
        sessions.sort((a, b) => b.startedAt - a.startedAt);

        if (!workspaceFolder) {
            return sessions[0] ?? null;
        }

        const workspaceNorm = normalizePath(workspaceFolder);

        // Prefer session whose cwd matches current workspace
        const match = sessions.find(s => workspaceNorm.startsWith(normalizePath(s.cwd)));
        return match ?? sessions[0] ?? null;
    } catch {
        return null;
    }
}

function cwdToProjectDir(cwd: string): string {
    // VSCode Claude extension stores transcripts under ~/.claude/projects/
    // with a directory name derived from cwd by replacing path separators
    // and colons with hyphens.
    // e.g. d:\code\ccstatusvsline -> d--code-ccstatusvsline
    return cwd.replace(/[:\\/]/g, '-');
}

function findTranscriptPath(sessionId: string, sessionCwd?: string): string | null {
    const candidates: string[] = [];

    try {
        // VSCode extension layout: ~/.claude/projects/<cwd-derived>/<sessionId>.jsonl
        const projectsDir = path.join(CLAUDE_DIR, 'projects');
        if (fs.existsSync(projectsDir) && sessionCwd) {
            const projectDir = path.join(projectsDir, cwdToProjectDir(sessionCwd));
            if (fs.existsSync(projectDir)) {
                const directPath = path.join(projectDir, `${sessionId}.jsonl`);
                if (fs.existsSync(directPath)) {
                    candidates.push(directPath);
                }

                // Also scan the project dir for any jsonl containing sessionId
                const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
                for (const file of files) {
                    if (file.includes(sessionId)) {
                        candidates.push(path.join(projectDir, file));
                    }
                }
            }

            // If no cwd match, search all project dirs for sessionId
            if (candidates.length === 0) {
                const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
                    .filter(d => d.isDirectory())
                    .map(d => path.join(projectsDir, d.name));
                for (const dir of projectDirs) {
                    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
                    for (const file of files) {
                        if (file.includes(sessionId)) {
                            candidates.push(path.join(dir, file));
                        }
                    }
                }
            }
        }

        // Legacy CLI layout: ~/.claude/transcripts/<sessionId>.jsonl
        if (fs.existsSync(TRANSCRIPTS_DIR)) {
            const files = fs.readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith('.jsonl'));
            for (const file of files) {
                if (file.includes(sessionId)) {
                    candidates.push(path.join(TRANSCRIPTS_DIR, file));
                }
            }
        }

        if (candidates.length === 0) {
            return null;
        }

        // Prefer the most recently modified candidate
        let best = candidates[0];
        let bestTime = fs.statSync(best).mtimeMs;
        for (let i = 1; i < candidates.length; i++) {
            const stat = fs.statSync(candidates[i]);
            if (stat.mtimeMs > bestTime) {
                best = candidates[i];
                bestTime = stat.mtimeMs;
            }
        }
        return best;
    } catch {
        return null;
    }
}

export function getTokenMetrics(transcriptPath: string): TokenMetrics {
    const lines = readJsonlFile(transcriptPath);

    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let contextLength = 0;

    let mostRecentMainChainEntry: TranscriptLine | null = null;
    let mostRecentTimestamp: Date | null = null;

    const parsedEntries: TranscriptLine[] = [];
    let hasStopReasonField = false;

    for (const line of lines) {
        const data = parseJsonlLine(line);
        if (data?.message?.usage) {
            parsedEntries.push(data);
            if (Object.hasOwn(data.message, 'stop_reason')) {
                hasStopReasonField = true;
            }
        }
    }

    const entriesToCount = hasStopReasonField
        ? parsedEntries.filter((data, index) => {
            const stopReason = data.message?.stop_reason;
            return Boolean(stopReason) || (stopReason === null && index === parsedEntries.length - 1);
        })
        : parsedEntries;

    for (const data of entriesToCount) {
        const usage = data.message?.usage;
        if (!usage) {
            continue;
        }

        inputTokens += usage.input_tokens || 0;
        outputTokens += usage.output_tokens || 0;
        cachedTokens += usage.cache_read_input_tokens ?? 0;
        cachedTokens += usage.cache_creation_input_tokens ?? 0;

        if (data.isSidechain !== true && data.timestamp && !data.isApiErrorMessage) {
            const entryTime = new Date(data.timestamp);
            if (!Number.isNaN(entryTime.getTime()) &&
                (!mostRecentTimestamp || entryTime > mostRecentTimestamp)) {
                mostRecentTimestamp = entryTime;
                mostRecentMainChainEntry = data;
            }
        }
    }

    if (mostRecentMainChainEntry?.message?.usage) {
        const usage = mostRecentMainChainEntry.message.usage;
        contextLength = (usage.input_tokens || 0)
            + (usage.cache_read_input_tokens ?? 0)
            + (usage.cache_creation_input_tokens ?? 0);
    }

    const totalTokens = inputTokens + outputTokens + cachedTokens;

    return { inputTokens, outputTokens, cachedTokens, totalTokens, contextLength };
}

export function getSessionDuration(transcriptPath: string): string | null {
    const lines = readJsonlFile(transcriptPath);
    if (lines.length === 0) {
        return null;
    }

    let firstTimestamp: Date | null = null;
    let lastTimestamp: Date | null = null;

    for (const line of lines) {
        const data = parseJsonlLine(line);
        if (data?.timestamp) {
            const t = new Date(data.timestamp);
            if (!Number.isNaN(t.getTime())) {
                firstTimestamp = t;
                break;
            }
        }
    }

    for (let i = lines.length - 1; i >= 0; i--) {
        const data = parseJsonlLine(lines[i]);
        if (data?.timestamp) {
            const t = new Date(data.timestamp);
            if (!Number.isNaN(t.getTime())) {
                lastTimestamp = t;
                break;
            }
        }
    }

    if (!firstTimestamp || !lastTimestamp) {
        return null;
    }

    const durationMs = lastTimestamp.getTime() - firstTimestamp.getTime();
    const totalMinutes = Math.floor(durationMs / (1000 * 60));

    if (totalMinutes < 1) {
        return '<1m';
    }

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours === 0) {
        return `${minutes}m`;
    } else if (minutes === 0) {
        return `${hours}hr`;
    } else {
        return `${hours}hr ${minutes}m`;
    }
}

function collectSpeedMetrics(transcriptPath: string): SpeedMetrics | null {
    const lines = readJsonlFile(transcriptPath);
    if (lines.length === 0) {
        return null;
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let requestCount = 0;

    let lastUserTimestamp: Date | null = null;
    let totalDurationMs = 0;

    for (const line of lines) {
        const data = parseJsonlLine(line);
        if (!data || data.isApiErrorMessage) {
            continue;
        }

        const entryTimestamp = data.timestamp ? new Date(data.timestamp) : null;

        if (data.type === 'user' && entryTimestamp && !Number.isNaN(entryTimestamp.getTime())) {
            lastUserTimestamp = entryTimestamp;
            continue;
        }

        if (data.type === 'assistant' && data.message?.usage) {
            inputTokens += data.message.usage.input_tokens || 0;
            outputTokens += data.message.usage.output_tokens || 0;
            requestCount++;

            if (entryTimestamp && lastUserTimestamp) {
                const diff = entryTimestamp.getTime() - lastUserTimestamp.getTime();
                if (diff > 0) {
                    totalDurationMs += diff;
                }
            }
        }
    }

    return {
        totalDurationMs,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        requestCount
    };
}

export function collectClaudeState(workspaceFolder?: string): ClaudeState {
    const settings = readClaudeSettings();
    const session = findActiveSession(workspaceFolder);
    const provider = getCurrentProvider('claude');

    let tokenMetrics: TokenMetrics = {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        contextLength: 0
    };
    let speedMetrics: SpeedMetrics | null = null;
    let sessionDuration: string | null = null;

    if (session) {
        const transcriptPath = findTranscriptPath(session.sessionId, session.cwd);
        if (transcriptPath) {
            tokenMetrics = getTokenMetrics(transcriptPath);
            sessionDuration = getSessionDuration(transcriptPath);
            speedMetrics = collectSpeedMetrics(transcriptPath);
        }
    }

    return {
        session,
        settings,
        provider,
        tokenMetrics,
        speedMetrics,
        sessionDuration,
        gitInfo: {},
        updatedAt: Date.now()
    };
}
