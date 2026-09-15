import { createRequire } from 'node:module';
import type { SQLInputValue, DatabaseSync as NativeDatabase } from 'node:sqlite';
const { DatabaseSync, backup } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database, Statement, QueryResult } from '../database';

class SqliteStatement implements Statement {
  constructor(
    readonly owner: NativeDatabase,
    readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    const normalized = values.map(value => {
      if (value === null || typeof value === 'string' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      throw new Error('Unsupported SQLite bind value');
    });
    return new SqliteStatement(this.owner, this.sql, normalized);
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.owner.prepare(this.sql).get(...this.values);
    return (row ? (column === undefined ? row : row[column]) : null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.owner.prepare(this.sql).all(...this.values) as T[] };
  }

  execute(): QueryResult {
    const result = this.owner.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }

  async run(): Promise<QueryResult> {
    return this.execute();
  }
}

export class SqliteDatabase implements Database {
  private readonly sqlite: NativeDatabase;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path, { timeout: 5000 });
    this.sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  }

  prepare(sql: string): Statement {
    return new SqliteStatement(this.sqlite, sql);
  }

  async batch(statements: Statement[]): Promise<QueryResult[]> {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      // No awaits here: another handler or scheduler cannot enter this transaction.
      const results = statements.map(statement => {
        if (!(statement instanceof SqliteStatement) || statement.owner !== this.sqlite) {
          throw new Error('Batch statement belongs to another database');
        }
        return statement.execute();
      });
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  migrate(directory: string, backupDirectory?: string): string[] {
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const applied = new Map(this.sqlite.prepare('SELECT name, sha256 FROM schema_migrations').all().map(row => [String(row.name), String(row.sha256)]));
    const files = readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort();
    if (!files.length) throw new Error('No database migrations found');
    for (const name of applied.keys()) {
      if (!files.includes(name)) throw new Error(`Applied migration is missing: ${name}`);
    }
    const pending = files.flatMap(name => {
      const sql = readFileSync(join(directory, name), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      if (applied.has(name)) {
        if (applied.get(name) !== hash) throw new Error(`Applied migration was modified: ${name}`);
        return [];
      }
      return [{ name, sql, hash }];
    });
    if (pending.length && backupDirectory && this.path !== ':memory:' && applied.size > 0) {
      mkdirSync(backupDirectory, { recursive: true });
      const path = join(backupDirectory, `before-migration-${Date.now()}.sqlite`);
      this.sqlite.prepare('VACUUM INTO ?').run(path);
    }
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      for (const { name, sql, hash } of pending) {
        this.sqlite.exec(sql);
        this.sqlite.prepare('INSERT INTO schema_migrations(name,sha256) VALUES(?,?)').run(name, hash);
      }
      this.sqlite.exec('COMMIT');
      return pending.map(m => m.name);
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  async backupTo(destination: string): Promise<void> {
    if (existsSync(destination)) throw new Error('Backup destination already exists');
    mkdirSync(dirname(destination), { recursive: true });
    await backup(this.sqlite, destination);
  }

  health(): void {
    this.sqlite.prepare('SELECT 1').get();
  }

  close(): void {
    this.sqlite.close();
  }
}
