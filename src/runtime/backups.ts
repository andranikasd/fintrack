import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { SqliteDatabase } from './sqlite';

/** Online SQLite backup includes committed WAL contents; do not copy a live .sqlite file. */
export async function dailyBackup(db: SqliteDatabase, directory: string, retention: number, now = new Date()): Promise<string> {
  const day = now.toISOString().slice(0, 10);
  const name = `fintrack-${day}.sqlite`;
  const existing: string[] = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (!existing.includes(name)) {
    const temporary = join(directory, `${name}.partial`);
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await db.backupTo(temporary);
    const { rename } = await import('node:fs/promises');
    await rename(temporary, join(directory, name));
  }
  const cutoff = new Date(now.getTime() - retention * 86400000).toISOString().slice(0, 10);
  for (const file of existing) {
    const match = /^fintrack-(\d{4}-\d{2}-\d{2})\.sqlite$/.exec(file);
    if (match && match[1]! <= cutoff) await unlink(join(directory, file));
  }
  return join(directory, name);
}
