import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createDashboardHandler } from '../src/web/server';
import { DashboardAuth } from '../src/web/auth';
import { describe,it,expect } from 'vitest';
import { testDb } from './sqlite';
import { dashboardAction } from '../src/web/actions';
import { workspaceAction } from '../src/web/workspace-actions';
import { todayIn,addDays } from '../src/lib/dates';
import { dashboardData } from '../src/web/data';
const tz='Asia/Yerevan';
async function fixture(){const {db,d1}=testDb();await db.ensureUser(1); await db.accounts.create(1,'Test account',0,'2000-01-01','test-account:1');await db.ensureUser(2); await db.accounts.create(2,'Test account',0,'2000-01-01','test-account:2');const today=todayIn(tz);const act=(body:Record<string,unknown>,user=1)=>dashboardAction(db,d1,user,tz,{requestId:crypto.randomUUID(),...body});return {db,d1,act,today};}
describe('dashboard workspace',()=>{
 it('previews rules without writes, combines variations, and applies categories atomically',async()=>{
  const {db,act,today}=await fixture(),category=(await db.categories(1))[0]!;
  await db.addTransaction(1,null,150,'Metro',today);await db.addTransaction(1,null,200,'metor',today);await db.addTransaction(2,null,500,'Metro',today);
  const preview=await act({action:'rule-preview',labels:'metro\nmetor',categoryId:category.id}) as {revision:number;count:number;fingerprint:string};expect(preview.count).toBe(2);expect(await db.finance.aliases(1)).toEqual([]);
  await act({action:'rule-save',labels:'metro\nmetor',categoryId:category.id,revision:preview.revision,fingerprint:preview.fingerprint,applyHistory:true});expect((await db.transactionsBetween(1,today,today)).every(r=>r.category_id===category.id)).toBe(true);expect(await db.finance.aliases(1)).toHaveLength(2);expect((await db.transactionsBetween(2,today,today))[0]!.category_id).toBeNull();
  await expect(act({action:'rule-save',labels:'metro',categoryId:category.id,revision:preview.revision,fingerprint:preview.fingerprint,applyHistory:true})).rejects.toThrow('stale');
 });
 it('rejects stale guarded changes without partial writes',async()=>{
  const {db,d1,today}=await fixture(),revision=await db.workspace.revision(1);await db.addTransaction(1,null,10,'Changed',today);
  await expect(db.workspace.guarded(1,revision,[d1.prepare('DELETE FROM transactions WHERE user_id=1')])).rejects.toThrow('Records changed');expect(await db.totalBetween(1,today,today)).toBe(10);
 });
 it('recovers manual edits and deletions including exact amounts and account assignment',async()=>{
  const {db,d1,act,today}=await fixture();await act({action:'account-create',label:'Card',opening:'0',openingOn:today});const account=(await db.accounts.list(1,today))[0]!;
  await act({action:'add-income',label:'Bonus',amount:'100.77',accountId:account.id});const income=(await db.income.list(1,today,today))[0]!;
  await act({action:'edit',kind:'income',id:income.id,label:'Bonus corrected',amount:'200.12',accountId:account.id,expected:{accountId:account.id,day:today,label:'Bonus',amountMinor:10077}});
  let history=(await db.workspace.history(1)).rows.find(r=>r.entity==='income'&&r.operation==='update')!;await act({action:'history-undo',id:history.id});expect((await db.income.list(1,today,today))[0]!.amount_minor).toBe(10077);
  await act({action:'delete',kind:'income',id:income.id,expected:{accountId:account.id,day:today,label:'Bonus',amountMinor:10077}});history=(await db.workspace.history(1)).rows.find(r=>r.entity==='income'&&r.operation==='delete')!;
  await act({action:'history-undo',id:history.id});expect((await db.accounts.list(1,today))[0]!.balance_minor).toBe(10077);await expect(act({action:'history-undo',id:history.id})).rejects.toThrow('Only manual');
 });
 it('refuses undo for newer changes, channel records and another owner',async()=>{
  const {db,d1,act,today}=await fixture(),id=await db.addTransaction(1,null,100,'item',today);
  await d1.prepare('UPDATE transactions SET amount=200 WHERE id=?').bind(id).run();const entry=(await db.workspace.history(1)).rows[0]!;await d1.prepare('UPDATE transactions SET amount=300 WHERE id=?').bind(id).run();await expect(act({action:'history-undo',id:entry.id})).rejects.toThrow('newer');await expect(act({action:'history-undo',id:entry.id},2)).rejects.toThrow();
  await db.finance.syncPost(1,-1001,1,1,1,today,[{categoryId:null,label:'metro',amount:150}],null);await db.finance.syncPost(1,-1001,1,2,2,today,[],null);const channelDelete=(await db.workspace.history(1)).rows.find(r=>r.entity==='transactions'&&r.operation==='delete')!;await expect(act({action:'history-undo',id:channelDelete.id})).rejects.toThrow('channel');expect(await db.totalBetween(1,today,today)).toBe(300);
 });
 it('invalidates logging confirmations after financial changes and refuses false no-spend days',async()=>{
  const {db,act,today}=await fixture();await act({action:'logging-day',day:today,status:'no-spend'});let data=await dashboardData(db,1,tz,today,today);expect(data.workspace.days).toHaveLength(1);
  await db.addTransaction(1,null,100,'item',today);data=await dashboardData(db,1,tz,today,today);expect(data.workspace.days).toEqual([]);await expect(act({action:'logging-day',day:today,status:'no-spend'})).rejects.toThrow('has expenses');await act({action:'logging-day',day:today,status:'complete'});
 });
 it('closes a checked month, detects later changes and preserves monetary balances during checks',async()=>{
  const {db,d1}=await fixture();await d1.prepare('DELETE FROM accounts WHERE user_id=1').run();const day='2026-01-01',today='2026-02-02';await d1.prepare("INSERT INTO accounts(user_id,name,opening_minor,opening_on) VALUES(1,'Card',10000,?)").bind(day).run();const a=(await db.accounts.list(1,today))[0]!;
  const act=(body:Record<string,unknown>)=>workspaceAction(db,db.workspace,1,today,{requestId:crypto.randomUUID(),...body});
  for(let d=day;d<='2026-01-31';d=addDays(d,1))await act({action:'logging-day',day:d,status:'no-spend'});
  let closing=await db.workspace.closing(db,1,'2026-01',today);expect(closing.ready).toBe(false);
  await act({action:'balance-check',period:'2026-01',accountId:a.id,amount:'100'});closing=await db.workspace.closing(db,1,'2026-01',today);expect(closing.ready).toBe(true);expect((await db.accounts.list(1,today))[0]!.balance_minor).toBe(10000);
  await act({action:'month-close',period:'2026-01',fingerprint:closing.fingerprint});expect((await db.workspace.closing(db,1,'2026-01',today)).changedSinceReview).toBe(false);
  await db.addTransaction(1,null,50,'forgotten',day);closing=await db.workspace.closing(db,1,'2026-01',today);expect(closing.changedSinceReview).toBe(true);expect(closing.ready).toBe(false);expect(closing.counts.unconfirmed).toBe(1);
 });
 it('persists owner-scoped saved views and validates their date behavior',async()=>{
  const {db,act,today}=await fixture();await act({action:'view-save',label:'Passive income',settings:{rangeMode:'month',chart:'lines',kind:'income',passive:'passive'}});const data=await dashboardData(db,1,tz,today,today);expect(data.workspace.views[0]!.settings.passive).toBe('passive');expect((await dashboardData(db,2,tz,today,today)).workspace.views).toEqual([]);
  await expect(act({action:'view-save',label:'Bad',settings:{rangeMode:'days',days:'9999',chart:'lines'}})).rejects.toThrow('1–366');
 });
 it('stores notes/receipts privately, rejects invalid files, and retains notes through deletion and undo',async()=>{
  const {db,act,today}=await fixture(),id=await db.addTransaction(1,null,100,'item',today);const attachment={action:'attachment-add',kind:'expense',id,note:'Warranty details',name:'receipt.pdf',mime:'application/pdf',data:btoa('%PDF-1.4\nexample'),requestId:crypto.randomUUID()};await act(attachment);await act(attachment);
  let data=await dashboardData(db,1,tz,today,today);expect(data.workspace.attachments).toHaveLength(1);expect(JSON.stringify(data)).not.toContain(attachment.data);await expect(act({...attachment,requestId:crypto.randomUUID(),mime:'image/png'})).rejects.toThrow('does not match');await expect(act({...attachment,requestId:crypto.randomUUID()},2)).rejects.toThrow('Entry no longer');
  await act({action:'delete',kind:'expense',id,expected:{accountId:1,day:today,label:'item',amountMinor:10000}});const history=(await db.workspace.history(1)).rows[0]!;await act({action:'history-undo',id:history.id});data=await dashboardData(db,1,tz,today,today);expect(data.workspace.attachments[0]!.entry_key).toBe(data.records[0]!.entryKey);
 });
 it('keeps attachment keys stable when a channel post is resynced',async()=>{
  const {db,act,today}=await fixture();await db.finance.syncPost(1,-1001,10,1,1,today,[{categoryId:null,label:'metro',amount:150}],null);let row=(await db.recentTransactions(1,1))[0]!;await act({action:'attachment-add',kind:'expense',id:row.id,note:'Ticket'});await db.finance.syncPost(1,-1001,10,2,2,today,[{categoryId:null,label:'metro',amount:200}],null);const data=await dashboardData(db,1,tz,today,today);expect(data.workspace.attachments[0]!.entry_key).toBe(data.records[0]!.entryKey);
 });
 it('requires the owner session for receipt downloads and history',async()=>{
  const {db,d1,act,today}=await fixture(),id=await db.addTransaction(1,null,100,'receipt item',today);
  const content='%PDF-1.4\nprivate receipt';await act({action:'attachment-add',kind:'expense',id,name:'receipt.pdf',mime:'application/pdf',data:btoa(content)});
  const attachment=(await db.workspace.data(db,1,today,today,today)).attachments[0]!;
  const handler=createDashboardHandler({DB:d1,DASHBOARD_URL:'http://localhost:8080',DEFAULT_TZ:tz,ALLOWED_USER_IDS:'1,2',BOT_TOKEN:'test',WEBHOOK_SECRET:'test',CURRENCY:'AMD',CURRENCY_SIGN:'֏'});
  const request=async(url:string,user?:number)=>{
   const token=user?await new DashboardAuth(d1).issue(user,'session'):null,req=Readable.from([]) as unknown as IncomingMessage;
   req.method='GET';req.url=url;req.headers=token?{cookie:'fintrack_session='+token}:{};
   let status=200,output='';const headers:Record<string,string>={};
   const response={setHeader:(key:string,value:string)=>{headers[key.toLowerCase()]=value;},writeHead:(code:number,values:Record<string,string>)=>{status=code;Object.assign(headers,values);},end:(value:string|Buffer)=>{output=value.toString();}} as unknown as ServerResponse;
   await handler(req,response);return {status,output,headers};
  };
  expect((await request('/api/attachment/'+attachment.id)).status).toBe(401);
  expect((await request('/api/attachment/'+attachment.id,2)).status).toBe(404);
  const download=await request('/api/attachment/'+attachment.id,1);expect(download.status).toBe(200);expect(download.output).toBe(content);expect(download.headers['Content-Disposition']).toContain('attachment;');expect(download.headers['X-Content-Type-Options']??download.headers['x-content-type-options']).toBe('nosniff');
  const history=JSON.parse((await request('/api/history',2)).output);expect(history.rows.every((r:{user_id:number})=>r.user_id===2)).toBe(true);
 });

});
