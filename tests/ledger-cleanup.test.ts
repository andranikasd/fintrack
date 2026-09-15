import { describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { testDb } from './sqlite';
import { createBot } from '../src/bot';
import { todayIn } from '../src/lib/dates';
import { dashboardAction } from '../src/web/actions';
import { dashboardData } from '../src/web/data';
import { DashboardAuth } from '../src/web/auth';
import { SqliteDatabase } from '../src/runtime/sqlite';
const tz='Asia/Yerevan';
const day=todayIn(tz);
async function fixture() {
  const {db,d1}=testDb();
  await db.ensureUser(1);await db.ensureUser(2);
  await db.accounts.create(1,'Card',100000,'2000-01-01','card');
  await db.accounts.create(1,'Cash',50000,'2000-01-01','cash');
  await db.accounts.create(2,'Other',10000,'2000-01-01','other');
  await db.finance.putGoal(1,'Laptop',1000000,null,10000,0,null);
  const goal=(await db.finance.goals(1))[0]!;
  const balances=async()=>Object.fromEntries((await db.accounts.list(1,day)).map(a=>[a.name,a.balance_minor]));
  return {db,d1,goal,balances};
}
function harness(d1:ReturnType<typeof testDb>['d1']) {
  const bot=createBot({DB:d1,BOT_TOKEN:'test',BOT_INFO:JSON.stringify({id:99,is_bot:true,first_name:'Test',username:'test_bot'}),ALLOWED_USER_IDS:'1,2',DEFAULT_TZ:tz,CURRENCY:'AMD',CURRENCY_SIGN:'֏',WEBHOOK_SECRET:'test'},{waitUntil:()=>{}});
  const calls:Array<{method:string;payload:any}>=[];
  bot.api.config.use(async(_next,method,payload)=>{calls.push({method,payload});return {ok:true,result:true} as never;});
  let update=100;
  const user=(id:number)=>({id,is_bot:false,first_name:'User'});
  const command=async(text:string,id=1,messageId=update++)=>bot.handleUpdate({update_id:messageId,message:{message_id:messageId,date:Math.floor(Date.now()/1000),from:user(id),chat:{id,type:'private'},text,...(text.startsWith('/')?{entities:[{type:'bot_command',offset:0,length:text.split(' ')[0]!.length}]}:{})}} as Update);
  const tap=async(data:string,id=1)=>bot.handleUpdate({update_id:update++,callback_query:{id:String(update),from:user(id),chat_instance:'x',data,message:{message_id:99,date:1,chat:{id,type:'private'},text:'Confirm'}}} as Update);
  return {bot,calls,command,tap};
}
describe('account ledger invariants',()=>{
  it('debits spending and exact savings, credits withdrawals, and deduplicates transfers',async()=>{
    const {db,goal,balances}=await fixture();
    await db.income.add(1,'Salary',100077,day,'income',1);
    const tx=await db.addTransaction(1,null,150,'metro',day,1,'expense');
    await db.addTransaction(1,null,150,'metro',day,1,'expense');
    await db.finance.contribute(1,goal.id,55077,day,'save',1);
    await db.finance.contribute(1,goal.id,55077,day,'save',1);
    await db.finance.contribute(1,goal.id,-10077,day,'withdraw',2);
    expect(await balances()).toEqual({Card:130000,Cash:60077});
    expect((await db.finance.goals(1))[0]!.saved_minor).toBe(45000);
    expect(await db.finance.contribute(1,goal.id,-45001,day,'overdraw',2)).toBe(false);
    await db.deleteTransaction(1,tx);
    expect(await balances()).toEqual({Card:145000,Cash:60077});
    const data=await dashboardData(db,1,tz,day,day);
    expect(data.records.find(r=>r.kind==='saving')?.accountId).toBe(1);
    expect(data.records.find(r=>r.kind==='withdrawal')?.accountId).toBe(2);
  });
  it('refuses missing, ambiguous and foreign accounts at both API and SQL boundaries',async()=>{
    const {db,d1,goal}=await fixture();
    await expect(db.addTransaction(1,null,10,'item',day)).rejects.toThrow('Choose an account');
    await expect(db.finance.contribute(1,goal.id,100,day,'missing')).rejects.toThrow('Choose an account');
    await expect(db.addTransaction(1,null,10,'item',day,3)).rejects.toThrow('owned');
    await expect(d1.prepare('INSERT INTO transactions(user_id,amount,spent_on) VALUES(1,10,?)').bind(day).run()).rejects.toThrow('owned account');
    await expect(d1.prepare('INSERT INTO savings(user_id,goal_id,amount_minor,saved_on,account_id) VALUES(2,?,100,?,3)').bind(goal.id,day).run()).rejects.toThrow('another user');
    for(const action of ['add-expense','save']) await expect(dashboardAction(db,d1,1,tz,{action,categoryId:null,id:goal.id,label:'item',amount:'10',requestId:crypto.randomUUID()})).rejects.toThrow('Choose the account');
    await db.ensureUser(4);
    await expect(db.addTransaction(4,null,10,'item',day)).rejects.toThrow('Choose an account');
    expect(await db.totalBetween(1,day,day)).toBe(0);
  });
  it('rejects stale dashboard edits after an account reassignment',async()=>{
    const {db,d1,balances}=await fixture();
    const id=await db.addTransaction(1,null,100,'item',day,1);
    const input={action:'edit',kind:'expense',id,label:'item',amount:'100',day,accountId:2,expected:{accountId:1,day,label:'item',amountMinor:10000},requestId:crypto.randomUUID()};
    await dashboardAction(db,d1,1,tz,input);
    await expect(dashboardAction(db,d1,1,tz,{...input,accountId:1,requestId:crypto.randomUUID()})).rejects.toThrow('changed');
    expect(await balances()).toEqual({Card:100000,Cash:40000});
  });
  it('atomically replaces account-linked channel savings and rolls back impossible removals',async()=>{
    const {db,goal,balances}=await fixture();
    const row={categoryId:null,label:'Laptop',goalId:goal.id,amount:50000,accountId:1};
    await db.finance.syncPost(1,-1001,1,1,1,day,[row],null);
    await db.finance.syncPost(1,-1001,1,2,2,day,[{...row,amount:40000,accountId:2}],null);
    expect(await balances()).toEqual({Card:100000,Cash:10000});
    await db.finance.contribute(1,goal.id,-30000,day,'withdraw',1);
    await expect(db.finance.forgetPost(1,-1001,1)).rejects.toThrow();
    expect(await balances()).toEqual({Card:130000,Cash:10000});
    expect((await db.finance.goals(1))[0]!.saved_minor).toBe(10000);
    expect(await db.finance.syncPost(2,-1001,1,3,3,day,[],null)).toBe(false);
    expect(await balances()).toEqual({Card:130000,Cash:10000});
  });
  it('does not resurrect forgotten source rows when the next expense is added',async()=>{
    const {db}=await fixture();
    await db.finance.syncPost(1,-1001,1,1,1,day,[{categoryId:null,label:'item',amount:100,accountId:1}],null,[],false,JSON.stringify({date:1,text:'item @ Card | 100'}));
    await db.finance.forgetPost(1,-1001,1);
    expect(await db.finance.latestPostForDay(1,day,-1001)).toBeNull();
    expect(await db.finance.syncPost(1,-1001,1,1,1,day,[{categoryId:null,label:'item',amount:100,accountId:1}],null)).toBe(false);
    expect(await db.totalBetween(1,day,day)).toBe(0);
  });
  it('handles private expense selection and retries without duplicate debits',async()=>{
    const {db,d1,balances}=await fixture();const {command,tap,calls}=harness(d1);
    await command('150 cafe');
    const button=calls.at(-1)!.payload.reply_markup.inline_keyboard.flat().find((b:any)=>b.callback_data.startsWith('entryaccount:1:'));
    expect(button).toBeDefined();
    await tap(button.callback_data);await tap(button.callback_data);
    expect(await balances()).toEqual({Card:85000,Cash:50000});
    await command('100 cafe @ Card',1,500);await command('100 cafe @ Card',1,500);
    expect(await db.totalBetween(1,day,day)).toBe(250);
  });
  it('refuses stale account buttons after another expense question replaces them',async()=>{
    const {db,d1}=await fixture();const {command,tap,calls}=harness(d1);
    await command('100 cafe');
    const old=calls.at(-1)!.payload.reply_markup.inline_keyboard[0][0].callback_data;
    await command('200 cafe');
    const current=calls.at(-1)!.payload.reply_markup.inline_keyboard[0][0].callback_data;
    await tap(old);expect(await db.totalBetween(1,day,day)).toBe(0);
    await tap(current);expect(await db.totalBetween(1,day,day)).toBe(200);
  });
  it('requires a source account for reminders and returns withdrawn funds to the named account',async()=>{
    const {db,d1,goal,balances}=await fixture();const {command,tap,calls}=harness(d1);
    await command('/save Laptop 100.77 @ Card');
    await command('/withdraw Laptop 50.77 @ Cash');
    const reminder=await db.finance.reminder(1,goal.id,day,10000);
    await tap(`saving:yes:${reminder.id}`);
    expect((await db.finance.getReminder(1,reminder.id))?.status).toBe('pending');
    const button=calls.at(-1)!.payload.reply_markup.inline_keyboard.flat().find((b:any)=>b.callback_data.startsWith('savingaccount:1:'));
    await tap(button.callback_data);await tap(button.callback_data);
    expect(await balances()).toEqual({Card:79923,Cash:55077});
    expect((await db.finance.goals(1))[0]!.saved_minor).toBe(15000);
  });
  it('rolls back channel account setup on invalid rows and rejects stale setup edits',async()=>{
    const {db,d1}=testDb();await db.ensureUser(1);await db.finance.link(-1001,1,'Diary');const {bot}=harness(d1);
    const post={message_id:1,date:Math.floor(Date.now()/1000),chat:{id:-1001,type:'channel' as const,title:'Diary'}};
    await bot.handleUpdate({update_id:1,channel_post:{...post,text:'account:Card | 1000\nsave:missing @ Card | 10'}});
    expect(await db.accounts.list(1,day)).toEqual([]);
    await bot.handleUpdate({update_id:3,edited_channel_post:{...post,edit_date:post.date+2,text:'account:Card | 1000\nmetro @ Card | 100'}});
    expect((await db.accounts.list(1,day))[0]!.balance_minor).toBe(90000);
    await bot.handleUpdate({update_id:2,edited_channel_post:{...post,edit_date:post.date+1,text:'account:Ghost | 999'}});
    expect((await db.accounts.list(1,day)).map(a=>a.name)).toEqual(['Card']);
  });
});
describe('cleanup',()=>{
  it('requires current owner confirmation and wipes every user table including audit history and access tokens',async()=>{
    const {db,d1,goal}=await fixture();const {command,tap,calls}=harness(d1);
    await db.finance.contribute(1,goal.id,10000,day,'save',1);
    await db.addTransaction(1,null,10,'item',day,1);
    await db.addTransaction(2,null,20,'other',day,3);
    await db.finance.link(-1001,1,'Diary');
    await db.finance.setTime(1,'reminder','20:00');
    const auth=new DashboardAuth(d1),token=await auth.issue(1,'session');
    await command('/cleanup');
    const data=calls.at(-1)!.payload.reply_markup.inline_keyboard[0][0].callback_data;
    await tap(data,2);expect(await db.totalBetween(1,day,day)).toBe(10);
    await tap(data);
    const tables=(await d1.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','mutation_guards')").all<{name:string}>()).results;
    for(const {name} of tables) expect(await d1.prepare(`SELECT COUNT(*) AS n FROM ${name} WHERE ${name==='users'?'id':'user_id'}=1`).first('n'),name).toBe(0);
    expect(await auth.session(token)).toBeNull();
    expect(await db.totalBetween(2,day,day)).toBe(20);
    await db.ensureUser(1);await db.accounts.create(1,'New',12300,day,'new');
    await tap(data);expect((await db.accounts.list(1,day))[0]!.balance_minor).toBe(12300);
    expect(await d1.prepare('PRAGMA foreign_key_check').all()).toEqual({results:[]});
  });
  it('cancels and expires confirmations without erasing data',async()=>{
    const {db,d1}=await fixture();const {command,tap}=harness(d1);
    await command('/cleanup');await tap('cleanup:cancel');
    expect(await db.accounts.list(1,day)).toHaveLength(2);
    await db.setState(1,'cleanup',{token:'expired',expires:Date.now()-1});
    expect(await db.cleanup(1,'expired')).toBe(false);
    expect(await db.accounts.list(1,day)).toHaveLength(2);
  });
});
it('migrates historical unassigned entries without inventing a real source account or changing totals',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'fintrack-legacy-'));const sql=new SqliteDatabase(':memory:');
  try {
    for(const file of readdirSync('migrations').filter(f=>f<'0007')) cpSync(join('migrations',file),join(directory,file));
    sql.migrate(directory);
    await sql.prepare('INSERT INTO users(id) VALUES(1)').run();
    await sql.prepare("INSERT INTO goals(user_id,name,target_minor,daily_minor) VALUES(1,'Laptop',100000,100)").run();
    await sql.prepare("INSERT INTO transactions(user_id,amount,spent_on) VALUES(1,150,'2026-09-01')").run();
    await sql.prepare("INSERT INTO savings(user_id,goal_id,amount_minor,saved_on) VALUES(1,1,5077,'2026-09-01')").run();
    await sql.prepare("INSERT INTO income(user_id,source,amount_minor,received_on) VALUES(1,'Salary',30000,'2026-09-01')").run();
    sql.migrate('migrations');
    const account=await sql.prepare('SELECT * FROM accounts').first<{id:number;name:string;opening_minor:number}>();
    expect(account!.name).toMatch(/^Legacy unassigned /);expect(account!.opening_minor).toBe(0);
    for(const table of ['transactions','income','savings']) expect(await sql.prepare(`SELECT account_id FROM ${table}`).first('account_id')).toBe(account!.id);
    expect(await sql.prepare('SELECT amount FROM transactions').first('amount')).toBe(150);
    expect(await sql.prepare('SELECT amount_minor FROM savings').first('amount_minor')).toBe(5077);
    expect(await sql.prepare('PRAGMA foreign_key_check').all()).toEqual({results:[]});
  } finally {sql.close();rmSync(directory,{recursive:true,force:true});}
});
