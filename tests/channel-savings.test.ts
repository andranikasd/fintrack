import { describe,it,expect } from 'vitest';
import { parseDailyPost } from '../src/lib/daily-post';
import { goalPlan,parseMinor } from '../src/lib/savings';
import { financialStatus } from '../src/lib/finance';
import { testDb } from './sqlite';
import { createBot } from '../src/bot';
import type { Env } from '../src/types';
import type { Update } from 'grammy/types';
const date = Date.parse('2026-09-15T08:00:00Z')/1000;
const parse=(text:string)=>parseDailyPost({text,date},'Asia/Yerevan');
const cell=(text:unknown)=>({text,align:'center',valign:'middle'});
const rich={blocks:[{type:'paragraph',text:'Sep 14'},{type:'table',cells:[['Item','price'],['redline','600'],['metro','150'],['duest','150'],['tun','3110'],['metri','150'],['duet','150']].map(r=>r.map(cell))},{type:'paragraph',text:'4310'}]};

describe('daily table parsing',()=> {
  it('reads the native table in the screenshot and excludes its footer',()=> {
    const result=parseDailyPost({date,rich_message:rich},'Asia/Yerevan');
    expect(result.day).toBe('2026-09-14');expect(result.rows).toHaveLength(6);expect(result.warning).toBeNull();
    expect(result.rows.reduce((s,r)=>s+r.amountMinor,0)).toBe(431000);
  });
  it('reads formatted cell text',()=> {
    expect(parseDailyPost({date,rich_message:{blocks:[{type:'table',cells:[[cell('Item'),cell('price')],[cell({type:'bold',text:['me','tro']}),cell('150')]]}]}},'Asia/Yerevan').rows[0]?.label).toBe('metro');
  });
  it('supports markdown, savings and mismatched totals',()=> {
    const result=parse('Sep 15\n| Item | price |\n|---|---|\n| metro | 150 |\n| save:laptop | 5,500.77 |\nTotal: 200');
    expect(result.rows[1]).toMatchObject({kind:'save',amountMinor:550077});expect(result.warning).toContain('150 AMD');
  });
  it('preserves date from original posting time on later edits',()=> {
    expect(parseDailyPost({text:'metro 150',date:Date.parse('2026-09-14T21:00Z')/1000},'Asia/Yerevan').day).toBe('2026-09-15');
  });
  it('allows an empty table to remove every row',()=>expect(parse('Sep 15\nItem | price').rows).toEqual([]));
  it.each(['Sep 15\nmetro 150\nbroken row','Sep 15\nmetro -150','Feb 30\nmetro 150','Sep 15\nmetro 150.77','Sep 15\nmetro 150\n900\ncoffee 50'])('rejects malformed posts without partial parsing: %s',text=>expect(()=>parse(text)).toThrow());
});

describe('exact savings and plans',()=> {
  it('keeps .77 and accepts abbreviations',()=> {expect(parseMinor('960,381.77')).toBe(96038177);expect(parseMinor('5.5k')).toBe(550000);expect(parseMinor('1.001')).toBeNull();});
  it('calculates deadline, cap and completion',()=> {
    const goal={id:1,user_id:1,name:'laptop',target_minor:96038177,opening_minor:0,saved_minor:0,deadline:'2027-03-13',daily_minor:null,cap_minor:null};
    expect(goalPlan(goal,'2026-09-15').required).toBe(Math.ceil(96038177/180));
    expect(goalPlan({...goal,cap_minor:300000},'2026-09-15').suggested).toBe(300000);
    expect(goalPlan({...goal,saved_minor:96038177},'2026-09-15').suggested).toBe(0);
  });
});

describe('SQLite sync and savings invariants',()=> {
  it('replaces only that post, handles duplicates/stale edits, date changes and row removal',async()=> {
    const {db}=testDb();await db.ensureUser(1);
    const row={categoryId:null,label:'metro',amount:150};
    await db.addTransaction(1,null,10,'private','2026-09-15');
    await db.finance.syncPost(1,-1001,1,date,1,'2026-09-15',[row],null);
    await db.finance.syncPost(1,-1001,2,date,2,'2026-09-15',[row],null);
    expect(await db.finance.syncPost(1,-1001,1,date,1,'2026-09-15',[row],null)).toBe(false);
    await db.finance.syncPost(1,-1001,1,date+2,4,'2026-09-14',[{...row,amount:600}],null);
    await db.finance.syncPost(1,-1001,1,date+1,3,'2026-09-15',[row],null);
    expect(await db.totalBetween(1,'2026-09-15','2026-09-15')).toBe(160);
    expect(await db.totalBetween(1,'2026-09-14','2026-09-14')).toBe(600);
    await db.finance.syncPost(1,-1001,1,date+3,5,'2026-09-14',[],null);
    expect(await db.totalBetween(1,'2026-09-14','2026-09-14')).toBe(0);
  });
  it('preserves valid records on invalid edits and refuses an older valid update',async()=> {
    const {db}=testDb();await db.ensureUser(1);
    await db.finance.syncPost(1,-1001,1,date,1,'2026-09-15',[{categoryId:null,label:'metro',amount:150}],null);
    await db.finance.syncPost(1,-1001,1,date+2,3,null,[],'invalid amount');
    expect(await db.finance.syncPost(1,-1001,1,date+1,2,'2026-09-15',[],null)).toBe(false);
    expect(await db.totalBetween(1,'2026-09-15','2026-09-15')).toBe(150);
    expect(await db.finance.errors(1)).toHaveLength(1);
  });
  it('rolls back an edit that would leave savings negative',async()=> {
    const {db}=testDb();await db.ensureUser(1);await db.finance.putGoal(1,'laptop',96038177,null,300000,0,null);
    const g=(await db.finance.goals(1))[0]!;
    await db.finance.syncPost(1,-1001,1,date,1,'2026-09-15',[{categoryId:null,label:'laptop',amount:500000,goalId:g.id}],null);
    await db.finance.contribute(1,g.id,-400000,'2026-09-15','withdraw1');
    await expect(db.finance.syncPost(1,-1001,1,date+1,2,'2026-09-15',[],null)).rejects.toThrow();
    expect((await db.finance.goals(1))[0]?.saved_minor).toBe(100000);
  });
  it('opening balance is not daily savings; confirmed transfers are idempotent and owner-scoped',async()=> {
    const {db}=testDb();await db.ensureUser(1);await db.finance.putGoal(1,'laptop',96038177,null,300000,20000000,null);
    const g=(await db.finance.goals(1))[0]!;
    expect(await db.finance.savingsTotal(1,'2026-09-01','2026-09-30')).toBe(0);
    expect(await db.finance.contribute(2,g.id,550077,'2026-09-15','foreign')).toBe(false);
    await db.finance.contribute(1,g.id,550077,'2026-09-15','once');await db.finance.contribute(1,g.id,550077,'2026-09-15','once');
    expect((await db.finance.goals(1))[0]?.saved_minor).toBe(20550077);
    expect(await db.finance.contribute(1,g.id,-99999999,'2026-09-15','overdraw')).toBe(false);
    await db.finance.putGoal(1,'laptop',96038177,null,200000,0,null);
    expect((await db.finance.goals(1))[0]?.opening_minor).toBe(20000000);
  });
  it('allocates shared budget across goals without overspending and subtracts confirmed transfers',async()=> {
    const {db}=testDb();await db.ensureUser(1);await db.setBudget(1,0,16000);await db.finance.setFunding(1,'shared',0);
    await db.finance.putGoal(1,'laptop',96038177,null,300000,0,null);await db.finance.putGoal(1,'trip',10000000,null,100000,0,null);
    const status=await financialStatus(db,1,'2026-09-15');expect(status.plans.reduce((s,p)=>s+p.suggested,0)).toBe(100000);
    expect(status.plans[0]?.suggested).toBe(75000);
    await db.finance.setFunding(1,'separate',0);
    const g=(await db.finance.goals(1))[0]!;await db.finance.contribute(1,g.id,300000,'2026-09-15','paid');
    expect((await financialStatus(db,1,'2026-09-15')).plans[0]?.suggested).toBe(0);
  });
  it('reminder confirmations are atomic and stale reminders cannot duplicate table savings',async()=> {
    const {db}=testDb();await db.ensureUser(1);await db.finance.putGoal(1,'laptop',96038177,null,300000,0,null);
    const g=(await db.finance.goals(1))[0]!,r=await db.finance.reminder(1,g.id,'2026-09-15',300000);
    expect(await db.finance.resolveReminder(2,r.id,300000)).toBe(false);
    expect(await db.finance.resolveReminder(1,r.id,300000)).toBe(true);
    expect(await db.finance.resolveReminder(1,r.id,300000)).toBe(false);
    const next=await db.finance.reminder(1,g.id,'2026-09-16',300000);
    await db.finance.contribute(1,g.id,300000,'2026-09-16','table');
    expect(await db.finance.resolveReminder(1,next.id,300000)).toBe(false);
    expect(await db.finance.resolveReminder(1,next.id,null)).toBe(true);
  });
});

it('routes channel updates without a sender, prevents unlinked channels, and survives malformed edits',async()=> {
  const {db,d1}=testDb();await db.ensureUser(1);await db.finance.link(-1001,1,'My finances');
  const info={id:99,is_bot:true as const,first_name:'Fintrack',username:'test_bot',can_join_groups:true,can_read_all_group_messages:false,supports_inline_queries:false};
  const bot=createBot({DB:d1,WEBHOOK_SECRET:'test',CURRENCY:'AMD',BOT_TOKEN:'test',BOT_INFO:JSON.stringify(info),ALLOWED_USER_IDS:'1',DEFAULT_TZ:'Asia/Yerevan',CURRENCY_SIGN:'֏'} as Env,{waitUntil:()=>{}} as unknown as ExecutionContext);
  const sent:unknown[]=[];
  bot.api.config.use(async(_prev,method,payload)=> {sent.push({method,payload});return {ok:true,result:true} as never;});
  const send=async(id:number,chat:number,rich_message:unknown,edited=false)=>bot.handleUpdate({update_id:id,[edited?'edited_channel_post':'channel_post']:{message_id:1,date,edit_date:edited?date+id:undefined,chat:{id:chat,type:'channel',title:'My finances'},rich_message}} as Update);
  await send(1,-1002,rich);expect(await db.totalBetween(1,'2026-09-14','2026-09-14')).toBe(0);
  await send(2,-1001,rich);expect(await db.totalBetween(1,'2026-09-14','2026-09-14')).toBe(4310);
  await send(3,-1001,{blocks:[{type:'paragraph',text:'broken'}]},true);
  expect(await db.totalBetween(1,'2026-09-14','2026-09-14')).toBe(4310);expect(sent).toHaveLength(1);
});
