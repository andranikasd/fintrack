import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteDatabase } from '../src/runtime/sqlite';
import { dailyBackup } from '../src/runtime/backups';
import { loadConfig } from '../src/runtime/config';
import { BackgroundTasks } from '../src/runtime/background';

const directories: string[] = [];
const databases: SqliteDatabase[] = [];
function temporary() { const dir = mkdtempSync(join(tmpdir(), 'fintrack-runtime-')); directories.push(dir); return dir; }
function open(path: string) { const db = new SqliteDatabase(path); databases.push(db); return db; }
afterEach(() => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* Already closed for persistence checks. */ } }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('production SQLite storage', () => {
  it('migrates once, persists across restarts, and stores exact savings', async () => {
    const path = join(temporary(), 'fintrack.sqlite');
    const db = open(path);
    expect(db.migrate('migrations')).toEqual(['0001_init.sql', '0002_channel_savings.sql', '0003_income.sql', '0004_dashboard.sql', '0005_accounts.sql']);
    await db.prepare('INSERT INTO users(id) VALUES(?)').bind(123).run();
    await db.prepare("INSERT INTO goals(user_id,name,target_minor,daily_minor) VALUES(123,'laptop',96038177,300000)").run();
    db.close();
    const restarted = open(path);
    expect(restarted.migrate('migrations')).toEqual([]);
    expect(await restarted.prepare('SELECT target_minor FROM goals').first('target_minor')).toBe(96038177);
    expect(await restarted.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(1);
  });

  it('rolls back all statements if an atomic batch fails', async () => {
    const db = open(':memory:'); db.migrate('migrations');
    await expect(db.batch([
      db.prepare('INSERT INTO users(id) VALUES(1)'),
      db.prepare('INSERT INTO users(id) VALUES(1)'),
    ])).rejects.toThrow();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(0);
  });

  it('does not let concurrent batches interleave', async () => {
    const db = open(':memory:'); db.migrate('migrations');
    await Promise.all(Array.from({ length: 10 }, (_, i) => db.batch([
      db.prepare('INSERT INTO users(id) VALUES(?)').bind(i + 1),
      db.prepare('INSERT INTO categories(user_id,name) VALUES(?,?)').bind(i + 1, 'Other'),
    ])));
    expect(await db.prepare('SELECT COUNT(*) AS n FROM categories').first('n')).toBe(10);
  });

  it('refuses modified applied migrations and rolls back a failed upgrade', async () => {
    const dir = temporary(), migrations = join(dir, 'migrations'); mkdirSync(migrations);
    writeFileSync(join(migrations, '0001.sql'), 'CREATE TABLE sample (id INTEGER PRIMARY KEY);');
    const db = open(join(dir, 'data.sqlite')); db.migrate(migrations);
    writeFileSync(join(migrations, '0002.sql'), 'ALTER TABLE sample ADD COLUMN label TEXT; INVALID SQL;');
    expect(() => db.migrate(migrations, join(dir, 'backups'))).toThrow();
    expect((await db.prepare('PRAGMA table_info(sample)').all<{name:string}>()).results.map(r => r.name)).toEqual(['id']);
    expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
    writeFileSync(join(migrations, '0001.sql'), 'CREATE TABLE something_else (id INTEGER);');
    expect(() => db.migrate(migrations)).toThrow('Applied migration was modified');
  });

  it('backs up committed WAL data, reopens the backup, and rotates only dated backups', async () => {
    const dir = temporary(), db = open(join(dir, 'live.sqlite')), backups = join(dir, 'backups');
    db.migrate('migrations'); await db.prepare('INSERT INTO users(id) VALUES(42)').run();
    const first = await dailyBackup(db, backups, 7, new Date('2026-09-15T12:00Z'));
    const bytes = readFileSync(first);
    await dailyBackup(db, backups, 7, new Date('2026-09-15T13:00Z'));
    expect(readFileSync(first)).toEqual(bytes);
    const copy = open(first);
    expect(await copy.prepare('SELECT id FROM users').first('id')).toBe(42); copy.close();
    writeFileSync(join(backups, 'manual-keep.sqlite'), 'keep');
    await dailyBackup(db, backups, 7, new Date('2026-09-22T12:00Z'));
    expect(readdirSync(backups)).toContain('manual-keep.sqlite');
    expect(readdirSync(backups)).not.toContain('fintrack-2026-09-15.sqlite');
    expect(readdirSync(backups)).toContain('fintrack-2026-09-22.sqlite');
  });
});

it('validates production configuration without leaking the supplied token', () => {
  const valid = { BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz', ALLOWED_USER_IDS: '123, 456' };
  expect(loadConfig(valid).tz).toBe('Asia/Yerevan');
  expect(() => loadConfig({ ...valid, ALLOWED_USER_IDS: '' })).toThrow('ALLOWED_USER_IDS');
  expect(() => loadConfig({ ...valid, DEFAULT_TZ: 'bad/timezone' })).toThrow('DEFAULT_TZ');
  expect(() => loadConfig({ ...valid, BACKUP_RETENTION_DAYS: '0' })).toThrow('BACKUP_RETENTION_DAYS');
  expect(() => loadConfig({ ...valid, BOT_TOKEN: 'secret-value' })).toThrow('Set BOT_TOKEN');
});

it('drains reports that were still running at shutdown', async () => {
  const tasks = new BackgroundTasks(); let finished = false;
  tasks.waitUntil(new Promise<void>(resolve => setTimeout(() => { finished = true; resolve(); }, 10)));
  await tasks.drain(); expect(finished).toBe(true);
});
