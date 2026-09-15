import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { testDb } from './sqlite';
import { parseDailyPost } from '../src/lib/daily-post';
import { todayIn, addDays } from '../src/lib/dates';
import { dashboardData } from '../src/web/data';
import { DashboardAuth } from '../src/web/auth';
import { dashboardAction } from '../src/web/actions';
import { renderDashboard } from '../src/web/render';
import { createDashboardHandler } from '../src/web/server';
import { financialStatus } from '../src/lib/finance';
import { createBot } from '../src/bot';
import type { Env } from '../src/types';

const requestId=()=>crypto.randomUUID();
async function fixture(){
  const {db,d1}=testDb();await db.ensureUser(1);await db.ensureUser(2);
  const day=todayIn('Asia/Yerevan'),from=addDays(day,-29);
  await d1.prepare('INSERT INTO accounts(user_id,name,opening_on) VALUES(?,?,?)').bind(1,'Card',from).run();
  const transport=(await db.categories(1)).find(c=>c.name==='Transport')!;
  await db.setBudget(1,0,150000);
  await db.finance.putGoal(1,'Laptop',96038177,null,300000,20000000,null);
  const goal=(await db.finance.goals(1))[0]!;
  await db.income.add(1,'Salary',45000000,from,'salary');
  for(let i=0;i<30;i++){
    await db.addTransaction(1,i%2?transport.id:null,150+i*30,i%2?'metro':'groceries',addDays(from,i));
    if(i%6===0)await db.finance.contribute(1,goal.id,550077,addDays(from,i),'deposit'+i);
  }
  await db.income.add(1,'Freelance',6500050,addDays(from,20),'freelance');
  return {db,d1,day,from,transport,goal};
}

describe('income tracking',()=>{
  it('parses income rows without counting them or savings as expenses',()=>{
    const parsed=parseDailyPost({date:Date.now()/1000,text:'Item | price\nincome:salary | 450000.77\nmetro | 150\nsave:laptop | 3000\nTotal: 150'},'Asia/Yerevan');
    expect(parsed.rows[0]).toEqual({kind:'income',label:'salary',amountMinor:45000077});expect(parsed.warning).toBeNull();
  });
  it('syncs income edits, duplicate updates, invalid edits and row removal atomically',async()=>{
    const {db,day}=await fixture();const row={label:'bonus',amount:1000077,categoryId:null,income:true};
    await db.finance.syncPost(1,-1001,1,100,1,day,[row,{label:'metro',amount:150,categoryId:null}],null);
    const total=await db.income.total(1,day,day);
    await db.finance.syncPost(1,-1001,1,100,1,day,[row],null);expect(await db.income.total(1,day,day)).toBe(total);
    await db.finance.syncPost(1,-1001,1,102,3,null,[],'invalid row');expect(await db.income.total(1,day,day)).toBe(total);
    await db.finance.syncPost(1,-1001,1,101,2,day,[],null);expect(await db.income.total(1,day,day)).toBe(total);
    await db.finance.syncPost(1,-1001,1,103,4,day,[{...row,amount:700000}],null);expect(await db.income.total(1,day,day)).toBe(700000);
    await db.finance.syncPost(1,-1001,1,104,5,day,[],null);expect(await db.income.total(1,day,day)).toBe(0);
  });
  it('records /income exactly once and handles income in channel messages',async()=>{
    const {db,d1,day}=await fixture();await db.finance.link(-1001,1,'Expenses');
    const env={DB:d1,BOT_TOKEN:'test',BOT_INFO:JSON.stringify({id:99,is_bot:true,first_name:'Test',username:'test_bot'}),ALLOWED_USER_IDS:'1',DEFAULT_TZ:'Asia/Yerevan',CURRENCY:'AMD',CURRENCY_SIGN:'֏',WEBHOOK_SECRET:'test'};
    const bot=createBot(env,{waitUntil:()=>{}});bot.api.config.use(async()=>({ok:true,result:true} as never));
    const update={update_id:1,message:{message_id:10,date:Math.floor(Date.now()/1000),from:{id:1,is_bot:false,first_name:'User'},chat:{id:1,type:'private' as const,first_name:'User'},text:'/income Bonus @ Card 1500.77',entities:[{type:'bot_command' as const,offset:0,length:7}]}};
    await bot.handleUpdate(update);await bot.handleUpdate(update);expect(await db.income.total(1,day,day)).toBe(150077);
    await bot.handleUpdate({update_id:2,channel_post:{message_id:1,date:Math.floor(Date.now()/1000),chat:{id:-1001,type:'channel',title:'Expenses'},text:'income:Gift @ Card | 2000'}});
    expect(await db.income.total(1,day,day)).toBe(350077);
  });
  it('leaves the chosen budget unchanged and keeps opening savings out of cash flow',async()=>{
    const {db,day}=await fixture();const status=await financialStatus(db,1,day);
    expect(status.budget).toBe(150000);expect(status.cashFlow).toBe(status.income-status.spent*100-status.saved);
    expect(status.saved).toBeLessThan(status.goals[0]!.saved_minor);
  });
});

describe('dashboard data and actions',()=>{
  it('includes all money types, scopes data to the owner, and rejects invalid ranges',async()=>{
    const {db,day,from}=await fixture();const data=await dashboardData(db,1,'Asia/Yerevan',from,day);
    expect(data.records.filter(r=>r.kind==='income')).toHaveLength(2);expect(data.records.filter(r=>r.kind==='expense')).toHaveLength(30);
    expect((await dashboardData(db,2,'Asia/Yerevan',from,day)).records).toEqual([]);
    await expect(dashboardData(db,1,'Asia/Yerevan','2020-01-01',day)).rejects.toThrow('366');
  });
  it('deduplicates dashboard income, expense and savings writes',async()=>{
    const {db,d1,day,goal}=await fixture();
    for(const action of ['add-income','add-expense','save']){
      const input={action,accountId:1,label:'extra',amount:'150',day,categoryId:null,id:goal.id,requestId:requestId()};
      await dashboardAction(db,d1,1,'Asia/Yerevan',input);await dashboardAction(db,d1,1,'Asia/Yerevan',input);
    }
    expect((await db.income.list(1,day,day)).filter(r=>r.source==='extra')).toHaveLength(1);
    expect((await db.transactionsBetween(1,day,day)).filter(r=>r.note==='extra')).toHaveLength(1);
    expect(await db.finance.savingsTotal(1,day,day)).toBe(15000);
  });
  it('protects channel amounts but lets category changes teach future imports',async()=>{
    const {db,d1,day,transport}=await fixture();await db.finance.syncPost(1,-1001,1,1,1,day,[{label:'subway',amount:150,categoryId:null}],null);
    const tx=(await db.recentTransactions(1,1))[0]!;
    await expect(dashboardAction(db,d1,1,'Asia/Yerevan',{action:'delete',kind:'expense',id:tx.id,requestId:requestId()})).rejects.toThrow('source channel');
    await dashboardAction(db,d1,1,'Asia/Yerevan',{action:'category',id:tx.id,categoryId:transport.id,requestId:requestId()});
    expect(await db.finance.aliases(1)).toContainEqual({label:'subway',category_id:transport.id});
    await expect(dashboardAction(db,d1,2,'Asia/Yerevan',{action:'category',id:tx.id,categoryId:transport.id,requestId:requestId()})).rejects.toThrow();
  });
  it('edits manual records with conflict detection and prevents cross-account changes',async()=>{
    const {db,d1,day}=await fixture();await db.income.add(1,'Bonus',10000,day,'bonus');const row=(await db.income.list(1,day,day))[0]!;
    const edit={action:'edit',accountId:1,kind:'income',id:row.id,label:'Bonus corrected',amount:'200.77',day,expected:{accountId:1,label:'Bonus',amountMinor:10000,day},requestId:requestId()};
    await dashboardAction(db,d1,1,'Asia/Yerevan',edit);expect(await db.income.total(1,day,day)).toBe(20077);
    await expect(dashboardAction(db,d1,1,'Asia/Yerevan',edit)).rejects.toThrow('changed');
    await expect(dashboardAction(db,d1,2,'Asia/Yerevan',edit)).rejects.toThrow();
  });
  it('embeds hostile labels safely and produces syntactically valid offline HTML',async()=>{
    const {db,day,from}=await fixture();await db.income.add(1,'</script><script>alert(1)</script>',100,day,'xss');
    const data=await dashboardData(db,1,'Asia/Yerevan',from,day),html=renderDashboard(data,false);
    expect(html).not.toContain('</script><script>alert(1)</script>');
    const bootstrap=html.match(/id="bootstrap">([\s\S]*?)<\/script>/)![1]!;
    expect(JSON.parse(bootstrap).live).toBe(false);
    const script=html.match(/<script>\s*([\s\S]*?)<\/script>/)![1]!;
    expect(()=>new Script(script)).not.toThrow();
    if(process.env.WRITE_DASHBOARD_HTML)writeFileSync(process.env.WRITE_DASHBOARD_HTML,html);
  });
});

describe('private dashboard sign-in',()=>{
  it('expires sign-in links, consumes them once, and revokes sessions',async()=>{
    const {d1}=await fixture();const auth=new DashboardAuth(d1),token=await auth.issue(1,'login',1000);
    expect(await auth.consumeLogin(token,2000)).toBe(1);expect(await auth.consumeLogin(token,2000)).toBeNull();
    const expired=await auth.issue(1,'login',1000);expect(await auth.consumeLogin(expired,601001)).toBeNull();
    const session=await auth.issue(2,'session',1000);expect(await auth.session(session,2000)).toBe(2);
    await auth.revoke(session);expect(await auth.session(session,2000)).toBeNull();
  });
  it('requires a session and same-origin writes and serves only the signed-in owner',async()=>{
    const {db,d1,from,day}=await fixture();
    const origin='http://127.0.0.1:8788';
    const handler=createDashboardHandler({DB:d1,DASHBOARD_URL:origin,DEFAULT_TZ:'Asia/Yerevan',ALLOWED_USER_IDS:'1,2',BOT_TOKEN:'test',WEBHOOK_SECRET:'test',CURRENCY:'AMD',CURRENCY_SIGN:'֏'} as Env);
    const call=async(url:string,method='GET',headers:Record<string,string>={},payload?:unknown)=>{
      const request=Readable.from(payload?[JSON.stringify(payload)]:[]) as unknown as IncomingMessage;
      request.url=url;request.method=method;request.headers=headers;
      let status=200,text='';const responseHeaders:Record<string,string>={};
      const response={setHeader:(key:string,value:string)=>{responseHeaders[key.toLowerCase()]=value;},writeHead:(code:number)=>{status=code;},end:(value:string)=>{text=value;}} as unknown as ServerResponse;
      await handler(request,response);return {status,headers:responseHeaders,data:JSON.parse(text)};
    };
    expect((await call('/api/dashboard')).status).toBe(401);
    const token=await new DashboardAuth(d1).issue(2,'login');
    const login=await call('/api/session','POST',{'content-type':'application/json',origin},{token});
    expect(login.status).toBe(200);const cookie=login.headers['set-cookie']!;expect(cookie).toContain('HttpOnly');expect(cookie).toContain('SameSite=Strict');
    const headers={cookie:cookie.split(';')[0]!};
    const own=await call(`/api/dashboard?from=${from}&to=${day}`,'GET',headers);expect(own.data.records).toEqual([]);
    const denied=await call('/api/action','POST',{...headers,origin:'https://evil.example','content-type':'application/json'},{action:'budget',amount:'1',requestId:requestId()});
    expect(denied.status).toBe(403);expect(await db.budget(1,0)).toBe(150000);
    await db.accounts.create(2,'Empty',0,day,'empty-account');
    const empty=(await db.accounts.list(2,day))[0]!;
    const unfunded=await call('/api/action','POST',{...headers,origin,'content-type':'application/json'},
      {action:'add-expense',label:'coffee',amount:'1',day,accountId:empty.id,categoryId:null,requestId:requestId()});
    expect(unfunded.status).toBe(405);expect(unfunded.data.error).toContain('read-only');
    expect(await db.totalBetween(2,day,day)).toBe(0);

  });
});
