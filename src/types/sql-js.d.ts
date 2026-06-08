declare module 'sql.js' {
    interface QueryResult {
        columns: string[];
        values: any[][];
    }

    interface ParamsObject {
        [key: string]: number | string | Uint8Array | null;
    }

    interface BindParams extends Array<string | number | Uint8Array | null> {}

    interface SqlJsConfig {
        locateFile?: (file: string) => string;
    }

    class Database {
        constructor(data?: Buffer | Uint8Array | number[]);
        run(sql: string, params?: BindParams | ParamsObject): Database;
        exec(sql: string, params?: BindParams): QueryResult[];
        each(sql: string, params: BindParams | ParamsObject, callback: (obj: Record<string, any>) => void, done: () => void): void;
        prepare(sql: string, params?: BindParams | ParamsObject): Statement;
        export(): Uint8Array;
        close(): void;
        getRowsModified(): number;
        createFunction(name: string, func: Function): void;
    }

    class Statement {
        bind(values?: BindParams | ParamsObject): boolean;
        step(): boolean;
        get(params?: BindParams): any[] | Record<string, any>;
        getColumnNames(): string[];
        getAsObject(params?: BindParams | BindParams): Record<string, any>;
        getSQL(): string;
        reset(): void;
        free(): boolean;
    }

    interface SqlJsStatic {
        Database: typeof Database;
        Statement: typeof Statement;
    }

    function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
    export = initSqlJs;
}
