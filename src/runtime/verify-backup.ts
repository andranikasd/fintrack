import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { SqliteDatabase } from './sqlite';

/** Restore only into an isolated temporary directory. Never open or modify live data. */
export async function verifyBackup(source:string,migrations='migrations') {
  if(!(await stat(source)).isFile())throw new Error('Choose a SQLite backup file.');
  const directory=await mkdtemp(join(tmpdir(),'fintrack-restore-check-'));
  let restored:SqliteDatabase|undefined;
  try {
    const destination=join(directory,'restored.sqlite');
    await copyFile(source,destination);
    restored=new SqliteDatabase(destination);
    if(await restored.prepare('PRAGMA integrity_check').first<string>('integrity_check')!=='ok')throw new Error('Backup failed SQLite integrity_check.');
    if((await restored.prepare('PRAGMA foreign_key_check').all()).results.length)throw new Error('Backup contains broken references.');
    const ledger=await restored.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','transactions','categories')").all();
    if(ledger.results.length!==3)throw new Error('This file is not a Fintrack backup.');
    const migrationChanges=restored.migrate(migrations);
    const tables=(await restored.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{name:string}>()).results;
    const counts:Record<string,number>={};const digest=createHash('sha256');
    for(const {name} of tables) {
      const safe='"'+name.replaceAll('"','""')+'"';
      const rows=(await restored.prepare(`SELECT * FROM ${safe}`).all<Record<string,unknown>>()).results;
      counts[name]=rows.length;
      digest.update(name+'\n');
      const canonical=rows.map(row=>JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b))))).sort();
      for(const row of canonical)digest.update(row+'\n');
    }
    const historicalDeficits=await restored.prepare('SELECT COUNT(DISTINCT account_id) AS n FROM account_daily_balances WHERE balance_minor<0').first<number>('n');
    restored.close();restored=undefined;
    restored=new SqliteDatabase(destination);
    if(await restored.prepare('PRAGMA integrity_check').first<string>('integrity_check')!=='ok')throw new Error('Restored database failed its restart check.');
    if((await restored.prepare('PRAGMA foreign_key_check').all()).results.length)throw new Error('Restored database has broken references.');
    return {ok:true,counts,migrationsApplied:migrationChanges,historicalDeficits:historicalDeficits??0,contentDigest:digest.digest('hex')};
  } finally {restored?.close();await rm(directory,{recursive:true,force:true});}
}
