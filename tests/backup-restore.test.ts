import { afterEach, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteDatabase } from '../src/runtime/sqlite';
import { Db } from '../src/db';
import { verifyBackup } from '../src/runtime/verify-backup';

const directories:string[]=[];
const databases:SqliteDatabase[]=[];
const temporary=()=>{const dir=mkdtempSync(join(tmpdir(),'fintrack-proof-'));directories.push(dir);return dir;};
const open=(path:string)=>{const sql=new SqliteDatabase(path);databases.push(sql);return sql;};
afterEach(()=>{for(const db of databases.splice(0))try{db.close();}catch{}for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});});

it('restores a populated backup without changing the live database or backup, retaining balances and guards',async()=>{
  const dir=temporary(),source=open(join(dir,'live.sqlite'));source.migrate('migrations');
  const db=new Db(source,'Asia/Yerevan'),day='2026-09-15';
  await db.ensureUser(1);await db.accounts.create(1,'Card',100000,day,'card');
  const category=(await db.categories(1))[0]!;
  await db.setBudget(1,category.id,5000);await db.finance.alias(1,'Coffee',category.id);
  await db.finance.putGoal(1,'Laptop',1000000,null,10000,0,null);
  const goal=(await db.finance.goals(1))[0]!;
  await db.income.add(1,'Salary',300077,day,'income',1);
  await db.addTransaction(1,category.id,150,'Coffee',day,1,'coffee');
  await db.finance.contribute(1,goal.id,10077,day,'saving',1);
  await db.finance.link(-1001,1,'Diary');await db.finance.setTime(1,'reminder','20:00');
  const backup=join(dir,'backup.sqlite');await source.backupTo(backup);
  const bytes=readFileSync(backup),balances=await db.accounts.list(1,day),goals=await db.finance.goals(1);
  if(process.env.WRITE_RESTORE_BACKUP)copyFileSync(backup,process.env.WRITE_RESTORE_BACKUP);
  const result=await verifyBackup(backup);
  expect(result).toMatchObject({ok:true,migrationsApplied:[],historicalDeficits:0,counts:{users:1,accounts:1,transactions:1,income:1,savings:1,goals:1}});
  expect((await verifyBackup(backup)).contentDigest).toBe(result.contentDigest);
  expect(readFileSync(backup)).toEqual(bytes);expect(await db.accounts.list(1,day)).toEqual(balances);
  const restoredPath=join(dir,'restore.sqlite');copyFileSync(backup,restoredPath);
  const restored=open(restoredPath),restoredDb=new Db(restored,'Asia/Yerevan');
  expect(await restoredDb.accounts.list(1,day)).toEqual(balances);
  expect(await restoredDb.finance.goals(1)).toEqual(goals);
  expect(await restoredDb.recentTransactions(1,10)).toEqual(await db.recentTransactions(1,10));
  expect(await restoredDb.income.total(1,day,day)).toBe(300077);
  await expect(restoredDb.addTransaction(1,null,999999,'Too much',day,1)).rejects.toThrow('Insufficient funds');
  expect(await restoredDb.totalBetween(1,day,day)).toBe(150);
  expect(readFileSync(backup)).toEqual(bytes);
});
it('rejects corrupt, empty and unrelated databases instead of creating a fresh ledger',async()=>{
  const dir=temporary(),corrupt=join(dir,'corrupt.sqlite'),empty=join(dir,'empty.sqlite'),other=join(dir,'other.sqlite');
  writeFileSync(corrupt,'broken database');writeFileSync(empty,'');open(other).close();
  for(const path of [corrupt,empty,other])await expect(verifyBackup(path)).rejects.toThrow();
  await expect(verifyBackup(join(dir,'missing.sqlite'))).rejects.toThrow();
});
