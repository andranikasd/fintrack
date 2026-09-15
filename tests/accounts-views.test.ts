import { describe,it,expect } from 'vitest';
import { testDb } from './sqlite';
import { dashboardAction } from '../src/web/actions';
import { dashboardInsights } from '../src/web/insights';
import { createBot } from '../src/bot';
import { todayIn,addDays } from '../src/lib/dates';
import { accountEntry } from '../src/lib/account-entry';
const tz='Asia/Yerevan';
async function fixture(){const {db,d1}=testDb();await db.ensureUser(1);await db.ensureUser(2);const day=todayIn(tz);
  const act=(body:Record<string,unknown>,user=1)=>dashboardAction(db,d1,user,tz,{requestId:crypto.randomUUID(),...body});
  await act({action:'account-create',label:'Card',opening:'1000.77',openingOn:day});
  const account=(await db.accounts.list(1,day))[0]!;return {db,d1,act,day,account};}
describe('accounts and dashboard views',()=>{
  it('counts only assigned activity from the opening date and never creates passive income automatically',async()=>{
    const {db,act,day,account}=await fixture();
    await act({action:'account-edit',id:account.id,version:account.version,label:'Card',opening:'1000.77',openingOn:day,passive:true});
    await act({action:'add-income',accountId:account.id,label:'Interest',amount:'200.15',passive:true});
    await act({action:'add-expense',accountId:account.id,label:'metro',categoryId:null,amount:'150'});
    await db.income.add(1,'older',50000,addDays(day,-1),'old',account.id);
    await db.income.add(1,'unassigned',90000,day,'unknown');
    const result=(await db.accounts.list(1,day))[0]!;expect(result.balance_minor).toBe(105092);expect(result.passive_income).toBe(1);
    expect((await db.accounts.list(1,addDays(day,5)))[0]!.balance_minor).toBe(105092);
    expect(await db.accounts.list(2,day)).toEqual([]);
  });
  it('requires owned active income accounts, detects stale account edits, and preserves old names',async()=>{
    const {db,act,day,account}=await fixture();
    await expect(act({action:'add-income',label:'Salary',amount:'10'})).rejects.toThrow('Choose the account');
    await expect(act({action:'add-income',accountId:account.id,label:'Salary',amount:'10'},2)).rejects.toThrow('active account');
    const edit={action:'account-edit',id:account.id,version:1,label:'Main card',opening:'1000.77',openingOn:day,archived:true};
    await act(edit);expect((await db.accounts.named(1,'Card',true))?.name).toBe('Main card');
    await expect(act(edit)).rejects.toThrow('changed');
    await expect(act({action:'add-income',accountId:account.id,label:'Salary',amount:'10'})).rejects.toThrow('active account');
    await expect(act({action:'account-create',label:'Card',opening:'0',openingOn:day})).rejects.toThrow('already uses');
  });
  it('deduplicates account creation and recalculates balances after manual edits and deletion',async()=>{
    const {db,act,day,account}=await fixture();const input={action:'account-create',label:'Cash',opening:'0',openingOn:day,requestId:crypto.randomUUID()};await act(input);await act(input);expect(await db.accounts.list(1,day)).toHaveLength(2);
    await act({action:'add-income',accountId:account.id,label:'Salary',amount:'200'});const row=(await db.income.list(1,day,day))[0]!;
    await act({action:'edit',kind:'income',id:row.id,label:'Salary',amount:'250.77',accountId:account.id,expected:{day,label:'Salary',amountMinor:20000}});
    expect((await db.accounts.list(1,day)).find(a=>a.id===account.id)!.balance_minor).toBe(125154);
    await act({action:'delete',kind:'income',id:row.id,expected:{day,label:'Salary',amountMinor:25077}});
    expect((await db.accounts.list(1,day)).find(a=>a.id===account.id)!.balance_minor).toBe(100077);
  });
  it('keeps account-linked channel edits atomic, including after an account rename',async()=>{
    const {db,d1,act,day,account}=await fixture();await db.finance.link(-1001,1,'Diary');
    const bot=createBot({DB:d1,BOT_TOKEN:'test',BOT_INFO:JSON.stringify({id:99,is_bot:true,first_name:'Test',username:'test_bot'}),ALLOWED_USER_IDS:'1',DEFAULT_TZ:tz,CURRENCY:'AMD',CURRENCY_SIGN:'֏',WEBHOOK_SECRET:'test'},{waitUntil:()=>{}});
    bot.api.config.use(async()=>({ok:true,result:true} as never));const date=Math.floor(Date.now()/1000);
    const post={message_id:10,date,chat:{id:-1001,type:'channel' as const,title:'Diary'},text:'income:Interest @ Card [passive] | 200.15\nmetro @ Card | 150'};
    await bot.handleUpdate({update_id:10,channel_post:post});expect((await db.accounts.list(1,day))[0]!.balance_minor).toBe(105092);
    await act({action:'account-edit',id:account.id,version:1,label:'Main card',opening:'1000.77',openingOn:day});
    await bot.handleUpdate({update_id:11,edited_channel_post:{...post,edit_date:date+1,text:'income:Interest @ Card [passive] | 250.15\nmetro @ Card | 100'}});
    expect((await db.accounts.list(1,day))[0]!.balance_minor).toBe(115092);expect((await db.income.list(1,day,day))[0]!.passive).toBe(1);
    await bot.handleUpdate({update_id:12,edited_channel_post:{...post,edit_date:date+2,text:'income:Interest @ Missing | 999'}});
    expect((await db.accounts.list(1,day))[0]!.balance_minor).toBe(115092);expect(await db.finance.errors(1)).toHaveLength(1);
  });
  it('compares equal month-to-date periods, handles zero income, and returns calendar, trends and review items',async()=>{
    const {db}=await fixture();await db.addTransaction(1,null,100,'metro','2026-03-10');await db.addTransaction(1,null,100,'metro','2026-03-10');
    await db.addTransaction(1,null,300,'metro','2026-02-10');await db.addTransaction(1,null,1000,'later','2026-02-20');
    const data=await dashboardInsights(db,1,'2026-03-15','2026-03-15');expect(data.month.expense).toBe(20000);expect(data.month.previous.expense).toBe(30000);expect(data.month.previous.to).toBe('2026-02-15');expect(data.month.savingsRate).toBeNull();
    expect(data.calendar).toContainEqual({day:'2026-03-10',total:200});expect(data.trendPeriods).toHaveLength(6);expect(data.review.duplicates[0]!.count).toBe(2);
    const short=await dashboardInsights(db,1,'2026-03-31','2026-03-31');expect(short.month.previous.to).toBe('2026-02-28');
    const other=await dashboardInsights(db,2,'2026-03-15','2026-03-15');expect(other.review.unknown).toEqual([]);expect(other.trends).toEqual([]);
  });
  it('edits goal plans without changing confirmed savings and manages category budgets',async()=>{
    const {db,act,day}=await fixture();await act({action:'goal-plan',label:'Laptop',target:'960381.77',daily:'3000'});const goal=(await db.finance.goals(1))[0]!;await db.finance.contribute(1,goal.id,100077,day,'save');
    await act({action:'goal-plan',id:goal.id,label:'Laptop',target:'960381.77',deadline:'2027-09-15',daily:'2000',cap:'5000'});expect((await db.finance.goals(1))[0]!.saved_minor).toBe(100077);
    const category=(await db.categories(1))[0]!;await act({action:'category-budget',categoryId:category.id,amount:'15000'});expect(await db.budget(1,category.id)).toBe(15000);await act({action:'category-budget',categoryId:category.id,amount:''});expect(await db.budget(1,category.id)).toBeNull();
    expect(accountEntry('Interest @ Savings account [passive]')).toEqual({label:'Interest',accountName:'Savings account',passive:true});
  });
});
