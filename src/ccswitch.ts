import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CCSWITCH_DIR = path.join(os.homedir(), '.cc-switch');
const CCSWITCH_SETTINGS_PATH = path.join(CCSWITCH_DIR, 'settings.json');
const CCSWITCH_DB_PATH = path.join(CCSWITCH_DIR, 'cc-switch.db');

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

interface CcSwitchSettings {
    currentProviderClaude?: string;
    currentProviderClaudeDesktop?: string;
}

export function readCcSwitchSettings(): CcSwitchSettings | null {
    return readJsonFile<CcSwitchSettings>(CCSWITCH_SETTINGS_PATH);
}

function parseProviderRow(row: string): CcSwitchProvider | null {
    // provider rows are pipe-delimited based on the schema
    // id|app_type|name|settings_config|website_url|category|created_at|sort_index|notes|icon|icon_color|meta|is_current|in_failover_queue|cost_multiplier|limit_daily_usd|limit_monthly_usd|provider_type
    const parts = row.split('|');
    if (parts.length < 14) {
        return null;
    }

    const settingsRaw = parseJson(parts[3]);
    const metaRaw = parseJson(parts[11]);

    return {
        id: parts[0],
        appType: parts[1],
        name: parts[2],
        settingsConfig: (settingsRaw && typeof settingsRaw === 'object') ? settingsRaw as CcSwitchProvider['settingsConfig'] : {},
        category: parts[5] || undefined,
        icon: parts[9] || undefined,
        iconColor: parts[10] || undefined,
        meta: (metaRaw && typeof metaRaw === 'object') ? metaRaw as Record<string, unknown> : {},
        isCurrent: parts[12] === '1',
        costMultiplier: parts[14] || '1.0',
        providerType: parts[17] || undefined
    };
}

function findSqlite3Binary(): string | null {
    const candidates: string[] = ['sqlite3'];

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
        candidates.push(
            path.join(localAppData, 'Android', 'Sdk', 'platform-tools', 'sqlite3.exe'),
            path.join(localAppData, 'Android', 'Sdk', 'platform-tools', 'sqlite3'),
            'C:\\sqlite\\sqlite3.exe',
            'C:\\Program Files\\SQLite\\sqlite3.exe',
            'C:\\Program Files (x86)\\SQLite\\sqlite3.exe'
        );
    } else if (process.platform === 'darwin') {
        candidates.push(
            '/usr/bin/sqlite3',
            '/opt/homebrew/bin/sqlite3',
            '/usr/local/bin/sqlite3'
        );
    } else {
        candidates.push(
            '/usr/bin/sqlite3',
            '/usr/local/bin/sqlite3',
            '/opt/sqlite3',
            path.join(os.homedir(), '.local', 'bin', 'sqlite3')
        );
    }

    for (const candidate of candidates) {
        try {
            if (candidate === 'sqlite3') {
                // Check PATH
                const { execFileSync } = require('child_process');
                execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
                return candidate;
            }
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        } catch {
            // try next
        }
    }

    return null;
}

function queryDb(sql: string): string[][] {
    try {
        if (!fs.existsSync(CCSWITCH_DB_PATH)) {
            return [];
        }

        const sqliteBin = findSqlite3Binary();
        if (!sqliteBin) {
            return [];
        }

        const { execFileSync } = require('child_process');
        const stdout = execFileSync(sqliteBin, [CCSWITCH_DB_PATH, sql], { encoding: 'utf-8' });
        return stdout
            .split(/\r?\n/)
            .filter((line: string) => line.trim() !== '')
            .map((line: string) => line.split('|'));
    } catch {
        return [];
    }
}

export function getCurrentProvider(appType: 'claude' | 'claude-desktop' = 'claude'): CcSwitchProvider | null {
    const settings = readCcSwitchSettings();
    if (!settings) {
        return null;
    }

    const providerId = appType === 'claude-desktop'
        ? settings.currentProviderClaudeDesktop
        : settings.currentProviderClaude;

    if (!providerId) {
        return null;
    }

    const rows = queryDb(
        `SELECT * FROM providers WHERE id='${providerId.replace(/'/g, "''")}' AND app_type='${appType.replace(/'/g, "''")}' LIMIT 1;`
    );

    if (rows.length === 0) {
        return null;
    }

    return parseProviderRow(rows[0].join('|'));
}

export function getCurrentModelFromProvider(provider?: CcSwitchProvider | null): string | null {
    if (!provider) {
        return null;
    }

    const env = provider.settingsConfig?.env ?? {};

    // Explicit model override in provider config
    if (env.ANTHROPIC_MODEL) {
        return env.ANTHROPIC_MODEL;
    }

    // Fallback: check default mappings based on Claude's model family
    // This requires reading Claude's settings.json which we do separately
    return null;
}

export function getProviderCostMultiplier(provider?: CcSwitchProvider | null): number {
    if (!provider) {
        return 1.0;
    }
    const parsed = parseFloat(provider.costMultiplier);
    return Number.isFinite(parsed) ? parsed : 1.0;
}
