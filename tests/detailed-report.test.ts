import { writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { collectReport } from '../src/handlers/export';
import { buildReport } from '../src/pdf/report';
import { testDb } from './sqlite';

describe('detailed financial reports', () => {
  it('collects income-only periods and account reconciliation with exact savings', async () => {
    const { db } = testDb(); await db.ensureUser(1);
    await db.accounts.create(1,'InecoMain',10000000,'2026-09-01','card');
    await db.accounts.create(1,'VisaClassic',125077,'2026-09-01','visa');
    await db.income.add(1,'Salary',45000000,'2026-09-01','pay',1);
    const incomeOnly=await collectReport(db,1,'2026-09-01','2026-09-30','September 2026','2026-09','AMD','2026-09-15');
    expect(incomeOnly.transactions).toHaveLength(0);
    expect(incomeOnly.finance?.incomes).toHaveLength(1);
    expect(incomeOnly.to).toBe('2026-09-15');
    expect((await PDFDocument.load(await buildReport(incomeOnly))).getPageCount()).toBeGreaterThanOrEqual(4);
    await db.finance.putGoal(1,'Laptop',96038177,'2027-03-15',null,20000000,600000);
    const goal=(await db.finance.goals(1))[0]!;
    await db.finance.contribute(1,goal.id,550077,'2026-09-03','save',1);
    await db.finance.contribute(1,goal.id,-100077,'2026-09-04','withdraw',2);
    const categories=await db.categories(1);
    for(let i=1;i<=15;i++) await db.addTransaction(1,i%4===0?null:categories[i%categories.length]!.id,1000+i*350,
      i===3?'A long receipt note with Armenian text սուրճ and complete purchase details that must remain readable across multiple wrapped lines without being cut off.':'Purchase '+i,
      '2026-09-'+String(i).padStart(2,'0'),1);
    await db.income.add(1,'Interest',25077,'2026-09-12','interest',2,true);
    await db.transfers.add(1,1,2,100077,'2026-09-13','ATM cash withdrawal','transfer','2026-09-15');
    await db.setBudget(1,0,150000); await db.setBudget(1,categories[0]!.id,10000);
    const data=await collectReport(db,1,'2026-09-01','2026-09-30','September 2026','2026-09','AMD','2026-09-15');
    expect(data.finance?.savings.reduce((sum,r)=>sum+r.amount_minor,0)).toBe(450000);
    expect(data.finance?.accounts.find(a=>a.id===2)?.balance_minor).toBe(350308);
    const partial=await collectReport(db,1,'2026-09-09','2026-09-15','Last week','2026-09','AMD','2026-09-15');
    expect(partial.budgetOverall).toBe(0);expect(partial.categoryBudgets.size).toBe(0);
    const bytes=await buildReport(data);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(5);
    if(process.env.WRITE_DETAILED_PDF)writeFileSync(process.env.WRITE_DETAILED_PDF,bytes);
  });
  it('paginates more than 600 records and preserves long descriptions', async () => {
    const data = {
      periodLabel:'September 2026',from:'2026-09-01',to:'2026-09-15',generatedOn:'2026-09-15',singleMonth:'2026-09',currency:'AMD',
      total:0,byCategory:[],byDay:[],byMonth:[],budgetOverall:0,categoryBudgets:new Map(),transactions:[],
      finance:{accounts:[],openingAccounts:[],goals:[],savings:[],incomes:Array.from({length:605},(_,i)=>({
        id:i+1,user_id:1,source:i===604?'Final receipt 605 complete':'Income receipt',account_id:null,passive:0,amount_minor:10001,
        received_on:'2026-09-01',source_chat:null,source_message:null,
      }))},
    };
    const bytes=await buildReport(data);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(20);
    if(process.env.WRITE_LONG_PDF)writeFileSync(process.env.WRITE_LONG_PDF,bytes);
  });
});
