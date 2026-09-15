import { join, resolve } from 'node:path';
import { SqliteDatabase } from './sqlite';

const path = join(process.env.DATA_DIR || '/data', 'fintrack.sqlite');
const destination = resolve(process.argv[2] || join(process.env.BACKUP_DIR || '/backups', `manual-${Date.now()}.sqlite`));
const db = new SqliteDatabase(path);
try {
  await db.backupTo(destination);
  console.log(`Backup written: ${destination}`);
} finally { db.close(); }
