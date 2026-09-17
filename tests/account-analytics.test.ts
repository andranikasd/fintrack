import { describe,it,expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { testDb } from './sqlite';
import { buildAccountModel } from '../src/web/account-model';
import { dashboardData } from '../src/web/data';
import { renderDashboard } from '../src/web/render';

async function fixture(){
 const {db,d1}=testDb();await db.ensureUser(1);await db.ensureUser(2);
 await db.accounts.create(1,'Everyday card',10000000,'2026-01-01','card');
 await db.accounts.create(1,'Cash wallet',2000000,'2026-09-05','cash');
 await db.accounts.create(1,'Savings account',8000000,'2026-01-01','savings');
 await db.accounts.create(2,'Private account',900000000,'2026-01-01','private');
 await db.finance.putGoal(1,'Emergency fund',60000000,null,100000,0,null);
 const goal=(await db.finance.goals(1))[0]!;
 const categories=await db.categories(1),food=categories.find(c=>c.name==='Food')?.id??categories[0]!.id;
 for(let month=1;month<=9;month++){
  const period='2026-'+String(month).padStart(2,'0');
  await db.income.add(1,'Salary',65000000,period+'-01','salary'+month,1);
  await db.income.add(1,'Interest',210055,period+'-03','interest'+month,3,true);
  for(let day=2;day<=(month===9?16:28);day+=3)await db.addTransaction(1,food,8000+day*380+month*230,'Groceries',period+'-'+String(day).padStart(2,'0'),1);
  await db.finance.contribute(1,goal.id,5000000,period+'-10','save'+month,1);
 }
 await db.income.add(1,'Freelance',12000077,'2026-08-21','freelance',1);
 await db.transfers.add(1,1,2,1000077,'2026-09-08','ATM','atm','2026-09-16');
 await db.finance.contribute(1,goal.id,-100055,'2026-09-11','return',1);
 await db.addTransaction(1,null,2500,'Coffee','2026-09-10',2);
 await db.income.add(2,'Secret',99000000,'2026-09-02','secret',4);
 return {db,d1};
}

describe('complete month-end account analytics',()=>{
 it('reconciles opening funds, income, spending, savings and transfers exactly in minor units',async()=>{
  const {db}=await fixture(),history=await db.accounts.analytics(1,'2026-09-16','2026-09-16','2026-09-16'),accounts=await db.accounts.list(1,'2026-09-16');
  const m=buildAccountModel(history,accounts,'2026-09');
  expect(m.rows).toHaveLength(3);expect(m.totals.income).toBe(65210055);expect(m.totals.passive).toBe(210055);
  expect(m.totals.funding).toBe(2000000);expect(m.totals.transferIn).toBe(1000077);expect(m.totals.transferOut).toBe(1000077);
  expect(m.totals.withdrawal).toBe(100055);
  for(const a of m.rows){expect(a.opening+a.funding+a.income-a.expense-a.saving+a.withdrawal+a.transferIn-a.transferOut).toBe(a.closing);expect(a.closing).toBe(accounts.find(r=>r.id===a.id)!.balance_minor)}
  expect(m.closing).toBe(accounts.reduce((n,a)=>n+a.balance_minor,0));
  expect(m.rows.find(a=>a.id===2)!.opening).toBe(0);
  expect(m.daily[0]!.accounts.find(a=>a.id===2)!.balance).toBeNull();expect(m.daily[4]!.accounts.find(a=>a.id===2)!.balance).toBe(2000000);
  expect(m.daily[16]!.balance).toBeNull();expect(m.daily[15]!.spent).toBe(m.totals.expense);
 });
 it('compares elapsed days for an unfinished month and complete months for a finished month',async()=>{
  const {db}=await fixture(),h=await db.accounts.analytics(1,'2026-09-16','2026-09-16','2026-09-16'),a=await db.accounts.list(1,'2026-09-16');
  const current=buildAccountModel(h,a,'2026-09'),prior=buildAccountModel(h,a,'2026-08');
  expect(current.previousTo).toBe('2026-08-16');expect(current.previous.income).toBe(65210055);
  expect(prior.previousTo).toBe('2026-07-31');expect(prior.totals.income).toBe(77210132);expect(prior.partial).toBe(false);
  expect(prior.rows.map(r=>r.id)).not.toContain(2);expect(current.months.at(-1)!.partial).toBe(true);
 });
 it('isolates accounts and owners and keeps source/category aggregates independent of ledger dates',async()=>{
  const {db}=await fixture(),data=await dashboardData(db,1,'Asia/Yerevan','2026-09-16','2026-09-16');
  expect(data.records).toHaveLength(0);
  const m=buildAccountModel(data.accountHistory,data.accounts,'2026-09',2);
  expect(m.rows.map(a=>a.name)).toEqual(['Cash wallet']);expect(m.totals.income).toBe(0);expect(m.totals.expense).toBe(250000);
  expect(m.categories).toEqual([{label:'Uncategorized',amount:250000}]);expect(m.sources).toEqual([]);
  expect(JSON.stringify(data.accountHistory)).not.toContain('Secret');expect(data.accountHistory.daily.some(r=>r.accountId===4)).toBe(false);
 });
 it('excludes pre-opening activity from account funds while reporting its existence',async()=>{
  const {db}=await fixture();await db.income.add(1,'Before opening',100077,'2026-09-01','early',2);
  const h=await db.accounts.analytics(1,'2026-09-16','2026-09-16','2026-09-16'),m=buildAccountModel(h,await db.accounts.list(1,'2026-09-16'),'2026-09',2);
  expect(m.totals.income).toBe(0);expect(m.excluded).toEqual([{period:'2026-09',kind:'income',amount:100077,count:1}]);
 });
 it('carries balances through inactive months and handles February comparisons',async()=>{
  const {db}=testDb();await db.ensureUser(1);await db.accounts.create(1,'Quiet',12345,'2025-01-01','quiet');
  const h=await db.accounts.analytics(1,'2026-03-31','2026-03-31','2026-03-31');
  const m=buildAccountModel(h,await db.accounts.list(1,'2026-03-31'),'2026-03');
  expect(m.previousTo).toBe('2026-02-28');expect(m.opening).toBe(12345);expect(m.closing).toBe(12345);expect(m.daily.every(d=>d.balance===12345)).toBe(true);
 });
 it('exports executable offline analytics with representative months and accounts',async()=>{
  const {db}=await fixture();await db.setBudget(1,0,350000);
  const data=await dashboardData(db,1,'Asia/Yerevan','2026-09-01','2026-09-16');
  const html=renderDashboard(data,false);for(const match of html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g))expect(()=>new Script(match[1]!)).not.toThrow();
  expect(html).not.toContain('__FINTRACK_');
  if(process.env.WRITE_ANALYTICS_HTML)writeFileSync(process.env.WRITE_ANALYTICS_HTML,html);
 });
});
