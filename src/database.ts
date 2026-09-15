/** Shared subset of Cloudflare D1 and the standalone SQLite adapter. */
export interface QueryResult {
  meta: { changes?: number };
}

export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<QueryResult>;
}

export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<QueryResult[]>;
}

export interface BackgroundWork {
  waitUntil(promise: Promise<unknown>): void;
}
