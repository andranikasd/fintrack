import { describe,it,expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import type { Api } from 'grammy';
import { testDb } from './sqlite';
import { buildDailyChart } from '../src/pdf/daily';
import { dailyReport,dailySeries } from '../src/handlers/daily';
import { runFinanceSchedule } from '../src/scheduled-finance';

describe('daily reports and schedules',()=> {
  it('reports expenses, opening balance, deposits, withdrawals and budget separately',async()=> {
    const {db}=testDb();await db.ensureUser(1); await db.accounts.create(1,'Test account',100000000,'2000-01-01','test-account:1');await db.setBudget(1,0,150000);
    await db.finance.setFunding(1,'shared',2000000);
    await db.finance.putGoal(1,'laptop',96038177,null,300000,20000000,null);
    const goal=(await db.finance.goals(1))[0]!;
    await db.addTransaction(1,null,900,'metro','2026-09-15');
    await db.finance.contribute(1,goal.id,550077,'2026-09-15','deposit');
    await db.finance.contribute(1,goal.id,-50000,'2026-09-15','withdraw');
    const text=await dailyReport(db,1,'2026-09-15','2026-09-15','֏');
    expect(text).toContain('Spent: 900 ֏');expect(text).toContain('Saved: 5,500.77 ֏');
    expect(text).toContain('Withdrawn from savings: 500 ֏');expect(text).toContain('124,099.23 ֏');
    const series=await dailySeries(db,1,'2026-09-14','2026-09-15');
    expect(series[0]).toEqual({day:'2026-09-14',spent:0,saved:0,withdrawn:0});
    expect(series[1]?.saved).toBe(5500.77);
  });
  it('sends local-time reminders once, does not book savings, and honors disabled times',async()=> {
    const {db}=testDb();await db.ensureUser(1); await db.accounts.create(1,'Test account',100000000,'2000-01-01','test-account:1');await db.finance.putGoal(1,'laptop',96038177,null,300000,0,null);
    await db.finance.setTime(1,'reminder','20:00');
    const sent:unknown[]=[];const api={sendMessage:async(...args:unknown[])=>{sent.push(args);}} as unknown as Api;
    await runFinanceSchedule(db,api,{id:1,tz:'Asia/Yerevan'},'֏',new Date('2026-09-15T15:59Z'));expect(sent).toHaveLength(0);
    await runFinanceSchedule(db,api,{id:1,tz:'Asia/Yerevan'},'֏',new Date('2026-09-15T16:00Z'));
    await runFinanceSchedule(db,api,{id:1,tz:'Asia/Yerevan'},'֏',new Date('2026-09-15T16:05Z'));expect(sent).toHaveLength(1);
    expect(await db.finance.savingsTotal(1,'2026-09-15','2026-09-15')).toBe(0);
    await db.finance.setTime(1,'reminder',null);
    await runFinanceSchedule(db,api,{id:1,tz:'Asia/Yerevan'},'֏',new Date('2026-09-16T16:00Z'));expect(sent).toHaveLength(1);
  });
  it('leases deliveries and permits retry after a failed send',async()=> {
    const {db}=testDb();expect(await db.finance.claimDelivery(1,'2026-09-15','summary',100)).toBe(true);
    expect(await db.finance.claimDelivery(1,'2026-09-15','summary',101)).toBe(false);
    await db.finance.finishDelivery(1,'2026-09-15','summary',false);
    expect(await db.finance.claimDelivery(1,'2026-09-15','summary',102)).toBe(true);
    await db.finance.finishDelivery(1,'2026-09-15','summary',true);
    expect(await db.finance.claimDelivery(1,'2026-09-15','summary',1000)).toBe(false);
  });
  it('renders daily charts and paginates long ranges',async()=> {
    const rows=Array.from({length:30},(_,i)=>({day:`2026-09-${String(i+1).padStart(2,'0')}`,spent:i%7===0?0:900+(i*131)%4300,saved:i%4===0?5500.77:0,withdrawn:i===20?1500:0}));
    const bytes=await buildDailyChart(rows,'2026-09-30');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    expect((await PDFDocument.load(await buildDailyChart([...rows,...rows,...rows],'2026-09-30'))).getPageCount()).toBe(3);
    if(process.env.WRITE_DAILY_PDF) writeFileSync(process.env.WRITE_DAILY_PDF,bytes);
  });
});
