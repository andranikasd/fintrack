import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { createComparisonModel } from '../src/web/comparison-model';
import { dashboardData, type DashboardRecord } from '../src/web/data';
import { renderDashboard } from '../src/web/render';
import { testDb } from './sqlite';

const model=createComparisonModel();
const row=(id:number,day:string,label:string,categoryId:number|null,amountMinor:number):DashboardRecord=>({id,day,label,categoryId,amountMinor,kind:'expense',category:categoryId===1?'Food':categoryId===2?'Transport':'Uncategorized',channel:false});
const records=[row(1,'2026-01-10','Coffee',1,10000),row(2,'2026-02-10',' coffee ',1,15000),row(3,'2026-02-20','Lunch',1,20000),row(4,'2026-04-10','Coffee',2,5000),row(5,'2026-04-12','Metro',2,10000),row(6,'2026-04-14','Other',null,100)];
const scope=()=>({categories:{mode:'exclude' as const,keys:[] as string[]},items:{mode:'exclude' as const,keys:[] as string[]},excluded:[] as string[]});

describe('dashboard comparison',()=>{
  it('combines category inclusion, item exclusion and individual exclusions without changing data',()=>{
    const selection={...scope(),categories:{mode:'include' as const,keys:[model.categoryKey(records[0]!)]},items:{mode:'exclude' as const,keys:[model.itemKey(records[2]!)]},excluded:['expense:1']};
    expect(records.filter(r=>model.matches(r,selection)).map(r=>r.id)).toEqual([2]);
    expect(records).toHaveLength(6);
    expect(records.filter(r=>model.matches(r,{...scope(),items:{mode:'include',keys:[]}}))).toEqual([]);
    expect(records.filter(r=>model.matches(r,scope()))).toEqual(records);
  });
  it('matches whole normalized item names, keeps different kinds separate and handles uncategorized items',()=>{
    const selection={...scope(),items:{mode:'include' as const,keys:[model.itemKey(records[0]!)]}};
    const similar={...records[0]!,label:'Coffee beans'};
    const income={...records[0]!,kind:'income' as const};
    expect([...records,similar,income].filter(r=>model.matches(r,selection)).map(r=>r.id)).toEqual([1,2,4]);
    expect(model.matches(records[5]!,{...scope(),categories:{mode:'include',keys:[model.categoryKey(records[5]!)]}})).toBe(true);
  });
  it('fills missing calendar months, totals exact minor units and never includes income',()=>{
    const result=model.compare([...records,{...records[0]!,kind:'income',amountMinor:990000}],'2026-01-01','2026-04-30','category');
    expect(result.months.map(m=>m.key)).toEqual(['2026-01','2026-02','2026-03','2026-04']);
    expect(result.totals).toEqual([10000,35000,0,15100]);
    expect(result.rows.find(r=>r.label==='Food')!.values).toEqual([10000,35000,0,0]);
    expect(result.counts).toEqual([1,2,0,3]);
    expect(model.change(15000,10000)).toEqual({amount:5000,percent:50});
    expect(model.change(0,10000)).toEqual({amount:-10000,percent:-100});
    expect(model.change(100,0)).toEqual({amount:100,percent:null});
  });
  it('compares only selected months and merges normalized item names across categories',()=>{
    const result=model.compare(records,'2026-01-01','2026-04-30','item',['2026-01','2026-04']);
    expect(result.months.map(m=>m.key)).toEqual(['2026-01','2026-04']);
    expect(result.rows.find(r=>r.label==='Coffee')!.values).toEqual([10000,5000]);
    expect(model.compare(records,'2026-01-01','2026-04-30','item',[]).months).toEqual([]);
  });
  it('labels partial months and aligns only shared calendar days, including leap years',()=>{
    const all=model.compare(records,'2026-01-05','2026-04-12','item');
    expect(all.months.map(m=>m.partial)).toEqual([true,false,false,true]);
    expect(all.totals).toEqual([10000,35000,0,15000]);
    const aligned=model.compare(records,'2026-01-05','2026-04-12','item',null,true);
    expect(aligned.months.map(m=>[m.from.slice(8),m.to.slice(8)])).toEqual(Array(4).fill(['05','12']));
    expect(aligned.totals).toEqual([10000,15000,0,15000]);
    expect(model.compare([],'2024-02-01','2024-03-31','category',null,true).months.map(m=>m.to)).toEqual(['2024-02-29','2024-03-29']);
    expect(model.compare(records,'2026-01-25','2026-02-10','category',null,true).months.every(m=>m.from>m.to)).toBe(true);
  });
  it('renders safe executable comparison scripts and a synthetic browser fixture',async()=>{
    const {db}=testDb();await db.ensureUser(1);
    await db.accounts.create(1,'Card',10000000,'2026-01-01','fixture');
    const account=(await db.accounts.named(1,'Card'))!.id;
    const categories=await db.categories(1),food=categories.find(c=>c.name==='Groceries')??categories[0]!,transport=categories.find(c=>c.name==='Transport')!;
    for(const r of records)await db.addTransaction(1,r.categoryId===1?food.id:r.categoryId===2?transport.id:null,r.amountMinor/100,r.label,r.day,account);
    await db.addTransaction(1,food.id,25,'</script><img src=x onerror=alert(1)>','2026-02-12',account);
    const data=await dashboardData(db,1,'Asia/Yerevan','2026-01-01','2026-04-30');
    const html=renderDashboard(data,false,'test_bot');
    expect(html).not.toContain('</script><img');
    for(const script of html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g))expect(()=>new Script(script[1]!)).not.toThrow();
    expect(html).not.toContain('__FINTRACK_COMPARISON_MODEL__');
    if(process.env.WRITE_COMPARISON_HTML)writeFileSync(process.env.WRITE_COMPARISON_HTML,html);
  });
});
