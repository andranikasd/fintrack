import { describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDatabase } from '../src/runtime/sqlite';
import { verifyBackup } from '../src/runtime/verify-backup';
import { Db } from '../src/db';
import { fixture, day } from './bot-fixture';
import { BillsDb } from '../src/bills-db';

describe('guided finance migration and concurrency',()=>{
  it('upgrades a populated v8 ledger unchanged and restores all new data from backup',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'fintrack-v9-'));
    let sql:SqliteDatabase|undefined;
    try{
      const migrations=join(directory,'migrations');
      cpSync('migrations',migrations,{recursive:true});
      rmSync(join(migrations,'0009_guided_finance.sql'));
      sql=new SqliteDatabase(join(directory,'ledger.sqlite'));sql.migrate(migrations);
      const db=new Db(sql,'Asia/Yerevan');await db.ensureUser(1);
      await db.accounts.create(1,'Card',100000,'2026-01-01','card');await db.accounts.create(1,'Cash',0,'2026-01-01','cash');
      await db.finance.putGoal(1,'Laptop',1000000,null,1000,0,null);
      const goal=(await db.finance.goals(1))[0]!;
      await db.addTransaction(1,null,100,'Coffee','2026-09-15',1);
      await db.income.add(1,'Salary',10077,'2026-09-15','salary',1);
      await db.finance.contribute(1,goal.id,1000,'2026-09-15','savings',1);
      const before={accounts:await db.accounts.list(1,'2026-09-15'),expenses:await db.recentTransactions(1,10),income:await db.income.list(1,'2026-09-15','2026-09-15'),savings:await db.finance.savingsEntries(1,'2026-09-15','2026-09-15')};
      expect(sql.migrate('migrations',join(directory,'snapshots'))).toEqual(['0009_guided_finance.sql']);
      expect(readdirSync(join(directory,'snapshots'))).toHaveLength(1);
      expect(await db.accounts.list(1,'2026-09-15')).toEqual(before.accounts);
      expect(await db.recentTransactions(1,10)).toEqual(before.expenses);
      expect(await db.income.list(1,'2026-09-15','2026-09-15')).toEqual(before.income);
      expect(await db.finance.savingsEntries(1,'2026-09-15','2026-09-15')).toEqual(before.savings);
      await db.transfers.add(1,1,2,5077,'2026-09-15','Cash','transfer','2026-09-15');
      await db.bills.save(1,{label:'Internet',amount_minor:1000,account_id:1,category_id:null,frequency:'monthly',next_due:'2026-09-15',remind_time:'09:00',enabled:1},'bill');
      await db.bills.due(1,'2026-09-15','10:00');
      await db.setState(1,'guided_entry',{request:crypto.randomUUID(),kind:'expense',label:'Lunch',step:'amount'});await db.pauseDraft(1);
      const backup=join(directory,'copy.sqlite');await sql.backupTo(backup);
      const proof=await verifyBackup(backup);expect(proof.ok).toBe(true);expect(proof.historicalDeficits).toBe(0);
      expect(proof.counts).toMatchObject({account_transfers:1,recurring_bills:1,bill_occurrences:1,saved_drafts:1,transactions:1,income:1,savings:1});
      expect(sql.migrate('migrations')).toEqual([]);
    }finally{sql?.close();rmSync(directory,{recursive:true,force:true});}
  });
  it('atomically rejects an existing-expense link if the expense changes during confirmation',async()=>{
    const h=await fixture();await h.db.bills.save(1,{label:'Internet',amount_minor:10000,account_id:1,category_id:null,frequency:'monthly',next_due:day,remind_time:'09:00',enabled:1},'bill');
    const [o]=await h.db.bills.due(1,day,'12:00'),expense=await h.db.addTransaction(1,null,100,'Internet',day,1);
    const bills=new BillsDb({prepare:query=>h.d1.prepare(query),batch:async statements=>{
      await h.d1.prepare('UPDATE transactions SET amount=200 WHERE id=?').bind(expense).run();return h.d1.batch(statements);
    }});
    expect(await bills.resolve(1,o!.id,day,'paid',expense)).toBeNull();
    expect((await h.db.bills.occurrence(1,o!.id))!.status).toBe('pending');
    expect((await h.db.bills.list(1))[0]!.next_due).toBe(day);
    expect(await h.d1.prepare('SELECT COUNT(*) AS n FROM mutation_guards').first('n')).toBe(0);
  });
  it('concurrent payment confirmations create only one expense',async()=>{
    const h=await fixture();await h.db.bills.save(1,{label:'Internet',amount_minor:10000,account_id:1,category_id:null,frequency:'monthly',next_due:day,remind_time:'09:00',enabled:1},'bill');
    const [o]=await h.db.bills.due(1,day,'12:00');
    const result=await Promise.all([h.db.bills.resolve(1,o!.id,day,'paid'),h.db.bills.resolve(1,o!.id,day,'paid')]);
    expect(result.filter(r=>r!==null)).toHaveLength(1);expect(await h.db.totalBetween(1,day,day)).toBe(100);
  });
});
