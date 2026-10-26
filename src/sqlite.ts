import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import initSqlJs from 'sql.js';

const execFileAsync = promisify(execFile);
const CCSWITCH_DIR = path.join(os.homedir(), '.cc-switch');
export const CCSWITCH_DB_PATH = path.join(CCSWITCH_DIR, 'cc-switch.db');
export const CCSWITCH_SETTINGS_PATH = path.join(CCSWITCH_DIR, 'settings.json');

export type SqlValue = string | number | null;
export type SqlRow = Record<string, unknown>;

let sqliteBinary: string | null | undefined;
let sqlJsPromise: ReturnType<typeof initSqlJs> | undefined;

function findSqlite3Binary(): string | null {
    const candidates: string[] = [];
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
        candidates.push(
            path.join(localAppData, 'Android', 'Sdk', 'platform-tools', 'sqlite3.exe'),
            'C:\\sqlite\\sqlite3.exe',
            'C:\\Program Files\\SQLite\\sqlite3.exe',
            'C:\\Program Files (x86)\\SQLite\\sqlite3.exe'
        );
    } else {
        candidates.push('/usr/bin/sqlite3', '/usr/local/bin/sqlite3', '/opt/homebrew/bin/sqlite3');
    }

    return candidates.find(candidate => fs.existsSync(candidate)) ?? 'sqlite3';
}

async function resolveSqlite3Binary(): Promise<string | null> {
    if (sqliteBinary !== undefined) {
        return sqliteBinary;
    }

    const candidate: string = findSqlite3Binary() ?? 'sqlite3';
    try {
        await execFileAsync(candidate, ['--version'], { timeout: 3000, windowsHide: true });
        sqliteBinary = candidate;
    } catch {
        sqliteBinary = null;
    }
    return sqliteBinary;
}

function interpolateSql(sql: string, params: SqlValue[]): string {
    let index = 0;
    return sql.replace(/\?/g, () => {
        if (index >= params.length) {
            throw new Error('SQLite 参数数量不足');
        }
        const value = params[index++];
        if (value === null) {
            return 'NULL';
        }
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) {
                throw new Error('SQLite 数字参数无效');
            }
            return String(value);
        }
        return `'${value.replace(/'/g, "''")}'`;
    });
}

async function queryWithCli(binary: string, sql: string): Promise<SqlRow[]> {
    const { stdout } = await execFileAsync(
        binary,
        ['-readonly', '-json', CCSWITCH_DB_PATH, sql],
        { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }
    );
    if (!stdout.trim()) {
        return [];
    }
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed as SqlRow[] : [];
}

async function queryWithSqlJs(sql: string): Promise<SqlRow[]> {
    sqlJsPromise ??= initSqlJs({
        locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm')
    });
    const SQL = await sqlJsPromise;
    const db = new SQL.Database(fs.readFileSync(CCSWITCH_DB_PATH));
    try {
        return db.exec(sql).flatMap(result => result.values.map(values => {
            const row: SqlRow = {};
            result.columns.forEach((column, index) => {
                row[column] = values[index];
            });
            return row;
        }));
    } finally {
        db.close();
    }
}

/** Read-only queries. The CLI sees committed WAL data; sql.js is the portable fallback. */
export async function queryCcSwitch(sql: string, params: SqlValue[] = []): Promise<SqlRow[]> {
    if (!fs.existsSync(CCSWITCH_DB_PATH)) {
        return [];
    }

    const statement = interpolateSql(sql, params);
    const binary = await resolveSqlite3Binary();
    if (binary) {
        try {
            return await queryWithCli(binary, statement);
        } catch (error) {
            console.warn('[ccstatusline] sqlite3 query failed, trying sql.js:', error);
        }
    }
    return queryWithSqlJs(statement);
}

export function numberValue(value: unknown, fallback = 0): number {
    if (value === null || value === undefined || value === '') {
        return fallback;
    }
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function stringValue(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}
