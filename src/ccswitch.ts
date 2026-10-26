import * as fs from 'fs';
import type { CcSwitchProvider } from './types';
import { CCSWITCH_SETTINGS_PATH, numberValue, queryCcSwitch, stringValue } from './sqlite';

export interface CcSwitchSettings {
    currentProviderClaude?: string;
    currentProviderClaudeDesktop?: string;
    claudeConfigDir?: string;
    usageDisplay?: {
        currency?: string;
        exchangeRates?: Record<string, number>;
        trendChartType?: 'bar' | 'area';
    };
}

function parseJson(data: string): unknown {
    try {
        return JSON.parse(data);
    } catch {
        return null;
    }
}

export function readCcSwitchSettings(): CcSwitchSettings | null {
    try {
        const parsed = parseJson(fs.readFileSync(CCSWITCH_SETTINGS_PATH, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed as CcSwitchSettings : null;
    } catch {
        return null;
    }
}

// Status JSON and webview messages never need API keys or auth tokens.
const SAFE_ENV_KEYS = new Set([
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
    'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
    'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
    'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
]);

function publicSettingsConfig(raw: unknown): CcSwitchProvider['settingsConfig'] {
    if (!raw || typeof raw !== 'object') {
        return {};
    }
    const config = raw as CcSwitchProvider['settingsConfig'];
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.env ?? {})) {
        if (SAFE_ENV_KEYS.has(key) && typeof value === 'string') {
            env[key] = value;
        }
    }
    return { env };
}

export async function getCurrentProvider(appType: 'claude' | 'claude-desktop' = 'claude'): Promise<CcSwitchProvider | null> {
    const settings = readCcSwitchSettings();
    const providerId = appType === 'claude-desktop'
        ? settings?.currentProviderClaudeDesktop
        : settings?.currentProviderClaude;

    try {
        const rows = providerId
            ? await queryCcSwitch(`SELECT id, app_type, name, settings_config, category, icon, icon_color,
                is_current, cost_multiplier, provider_type FROM providers
                WHERE id = ? AND app_type = ? LIMIT 1`, [providerId, appType])
            : await queryCcSwitch(`SELECT id, app_type, name, settings_config, category, icon, icon_color,
                is_current, cost_multiplier, provider_type FROM providers
                WHERE app_type = ? AND is_current = 1 ORDER BY rowid DESC LIMIT 1`, [appType]);
        const row = rows[0];
        if (!row) {
            return null;
        }
        return {
            id: stringValue(row.id),
            appType: stringValue(row.app_type),
            name: stringValue(row.name, '未知供应商'),
            settingsConfig: publicSettingsConfig(parseJson(stringValue(row.settings_config))),
            category: stringValue(row.category) || undefined,
            icon: stringValue(row.icon) || undefined,
            iconColor: stringValue(row.icon_color) || undefined,
            isCurrent: row.is_current === 1 || row.is_current === '1',
            costMultiplier: typeof row.cost_multiplier === 'string'
                ? row.cost_multiplier
                : String(numberValue(row.cost_multiplier, 1)),
            providerType: stringValue(row.provider_type) || undefined
        };
    } catch (error) {
        console.warn('[ccstatusline] Unable to read CC Switch provider:', error);
        return null;
    }
}
