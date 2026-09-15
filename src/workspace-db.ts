import type { Database, Statement } from './database';
import type { Db } from './db';
import { monthEnd, monthStart, addDays } from './lib/dates';
export interface HistoryEntry {id:number;user_id:number;entity:string;record_id:number;operation:string;before_json:string|null;after_json:string|null;created_at:string;undone_at:string|null;}
export class WorkspaceError extends Error {}
const normalize=(s:string)=>s.trim().toLowerCase();
export class WorkspaceDb {
  constructor(readonly sql:Database){}
  async revision(user:number){return (await this.sql.prepare('SELECT revision FROM finance_revisions WHERE user_id=?').bind(user).first<{revision:number}>())?.revision??0;}
  async guarded(user:number,revision:number,statements:Statement[]){
    const key=crypto.randomUUID();
    try{return await this.sql.batch([
      this.sql.prepare('INSERT INTO mutation_guards(id,expected,actual) VALUES(?,?,COALESCE((SELECT revision FROM finance_revisions WHERE user_id=?),0))').bind(key,revision,user),
      ...statements,this.sql.prepare('DELETE FROM mutation_guards WHERE id=?').bind(key),
    ]);}catch(error){if(error instanceof Error&&/CHECK constraint failed/.test(error.message))throw new WorkspaceError('Records changed. Refresh and preview again.');throw error;}
  }
  async history(user:number,before=Number.MAX_SAFE_INTEGER){
    const rows=(await this.sql.prepare('SELECT * FROM change_history WHERE user_id=? AND id<? ORDER BY id DESC LIMIT 51').bind(user,before).all<HistoryEntry>()).results;
    return {rows:rows.slice(0,50),next:rows.length>50?rows[49]!.id:null};
  }
  async undo(user:number,id:number){
    const revision=await this.revision(user),entry=await this.sql.prepare('SELECT * FROM change_history WHERE user_id=? AND id=?').bind(user,id).first<HistoryEntry>();
    if(!entry||entry.undone_at||!['transactions','income'].includes(entry.entity)||!['update','delete'].includes(entry.operation))throw new WorkspaceError('Only manual expense or income edits and deletions can be undone.');
    const before=entry.before_json?JSON.parse(entry.before_json) as Record<string,unknown>:null;
    if(!before||before.source_chat!==null)throw new WorkspaceError('Correct channel records in the original channel post.');
    const latest=await this.sql.prepare('SELECT MAX(id) AS id FROM change_history WHERE user_id=? AND entity=? AND record_id=?').bind(user,entry.entity,entry.record_id).first<{id:number}>();
    if(latest?.id!==id)throw new WorkspaceError('A newer change exists for this record. Undo the latest eligible change first.');
    const current=await this.sql.prepare(`SELECT * FROM ${entry.entity} WHERE user_id=? AND id=?`).bind(user,entry.record_id).first<Record<string,unknown>>();
    if(entry.operation==='delete'&&current)throw new WorkspaceError('This record has already been restored.');
    if(entry.operation==='update'&&(!current||Object.entries(JSON.parse(entry.after_json!)).some(([key,value])=>current[key]!==value)))throw new WorkspaceError('This record changed. Refresh its history.');
    if(before.category_id!=null&&!await this.sql.prepare('SELECT id FROM categories WHERE user_id=? AND id=?').bind(user,before.category_id).first())throw new WorkspaceError('Restore the missing category before undoing this change.');
    if(before.account_id!=null&&!await this.sql.prepare('SELECT id FROM accounts WHERE user_id=? AND id=?').bind(user,before.account_id).first())throw new WorkspaceError('The original account is unavailable.');
    const columns=Object.keys(before),values=Object.values(before);
    const restore=entry.operation==='delete'?this.sql.prepare(`INSERT INTO ${entry.entity}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...values)
      :this.sql.prepare(`UPDATE ${entry.entity} SET ${columns.map(c=>c+'=?').join(',')} WHERE user_id=? AND id=?`).bind(...values,user,entry.record_id);
    await this.guarded(user,revision,[restore,this.sql.prepare("UPDATE change_history SET undone_at=datetime('now') WHERE user_id=? AND id=?").bind(user,id)]);
  }
  async rulePreview(user:number,labels:string[],category:number){
    const revision=await this.revision(user),wanted=new Set(labels.map(normalize));
    const records=(await this.sql.prepare('SELECT id,note,category_id,amount,spent_on FROM transactions WHERE user_id=? ORDER BY spent_on DESC,id DESC').bind(user).all<{id:number;note:string;category_id:number|null;amount:number;spent_on:string}>()).results.filter(r=>wanted.has(normalize(r.note))&&r.category_id!==category);
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({revision,category,labels:[...wanted].sort(),records})));
    const fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    return {revision,fingerprint,count:records.length,total:records.reduce((s,r)=>s+r.amount,0),examples:records.slice(0,25),records};
  }
  async applyRule(user:number,labels:string[],category:number,revision:number,applyHistory:boolean,fingerprint:string){
    const preview=await this.rulePreview(user,labels,category);
    if(preview.revision!==revision||preview.fingerprint!==fingerprint)throw new WorkspaceError('The preview is stale. Preview the rule again.');
    const statements=labels.map(name=>this.sql.prepare('INSERT INTO aliases(user_id,label,category_id) VALUES(?,?,?) ON CONFLICT(user_id,label) DO UPDATE SET category_id=excluded.category_id').bind(user,name.trim(),category));
    if(applyHistory&&preview.records.length)statements.push(this.sql.prepare('UPDATE transactions SET category_id=? WHERE user_id=? AND id IN (SELECT value FROM json_each(?))').bind(category,user,JSON.stringify(preview.records.map(r=>r.id))));
    await this.guarded(user,revision,statements);
  }
  async closing(db:Db,user:number,period:string,today:string){
    const from=monthStart(period),to=monthEnd(period),end=to>today?today:to;
    const [accounts,counts,days,checks,review,history,errors]=await Promise.all([
      db.accounts.list(user,end),
      this.sql.prepare(`SELECT COUNT(*) AS expenses,SUM(CASE WHEN category_id IS NULL THEN 1 ELSE 0 END) AS uncategorized,SUM(CASE WHEN account_id IS NULL THEN 1 ELSE 0 END) AS unassigned FROM transactions WHERE user_id=? AND spent_on BETWEEN ? AND ?`).bind(user,from,end).first<{expenses:number;uncategorized:number|null;unassigned:number|null}>(),
      this.sql.prepare('SELECT day,status FROM logging_days WHERE user_id=? AND day BETWEEN ? AND ? ORDER BY day').bind(user,from,end).all<{day:string;status:string}>(),
      this.sql.prepare('SELECT account_id,actual_minor FROM balance_checks WHERE user_id=? AND period=?').bind(user,period).all<{account_id:number;actual_minor:number}>(),
      this.sql.prepare('SELECT * FROM month_reviews WHERE user_id=? AND period=?').bind(user,period).first<{fingerprint:string;reviewed_at:string}>(),
      this.sql.prepare(`SELECT MAX(id) AS id FROM change_history WHERE user_id=? AND (
        COALESCE(json_extract(before_json,'$.spent_on'),json_extract(before_json,'$.received_on'),json_extract(before_json,'$.saved_on')) BETWEEN ? AND ? OR
        COALESCE(json_extract(after_json,'$.spent_on'),json_extract(after_json,'$.received_on'),json_extract(after_json,'$.saved_on')) BETWEEN ? AND ?)`)
        .bind(user,from,end,from,end).first<{id:number|null}>(),
      this.sql.prepare('SELECT COUNT(*) AS count FROM channel_posts WHERE user_id=? AND error IS NOT NULL AND (spent_on BETWEEN ? AND ? OR spent_on IS NULL)').bind(user,from,end).first<{count:number}>(),
    ]);
    const unassignedIncome=(await this.sql.prepare('SELECT COUNT(*) AS count FROM income WHERE user_id=? AND account_id IS NULL AND received_on BETWEEN ? AND ?').bind(user,from,end).first<{count:number}>())!.count;
    const balances=accounts.filter(a=>a.opening_on<=end).map(a=>{const actual=checks.results.find(c=>c.account_id===a.id)?.actual_minor??null;return {id:a.id,name:a.name,recorded:a.balance_minor,actual,difference:actual===null?null:actual-a.balance_minor};});
    const elapsed=end>=from?Number(end.slice(8)):0,unconfirmed=Math.max(0,elapsed-days.results.length);
    const details={period,counts:{uncategorized:counts?.uncategorized??0,unassigned:(counts?.unassigned??0)+unassignedIncome,unconfirmed,errors:errors?.count??0},balances,days:days.results,history:history?.id??0};
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(details)));
    const fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    const ready=to<today&&Object.values(details.counts).every(n=>n===0)&&balances.every(a=>a.difference===0);
    return {...details,fingerprint,ready,reviewedAt:review?.reviewed_at??null,changedSinceReview:Boolean(review&&review.fingerprint!==fingerprint),ended:to<today};
  }
  async data(db:Db,user:number,from:string,to:string,today:string){
    const [views,rules,history,days,attachments,closing,revision]=await Promise.all([
      this.sql.prepare('SELECT id,name,settings FROM saved_views WHERE user_id=? ORDER BY lower(name)').bind(user).all<{id:number;name:string;settings:string}>(),db.finance.aliases(user),this.history(user),
      this.sql.prepare('SELECT day,status FROM logging_days WHERE user_id=? AND day BETWEEN ? AND ?').bind(user,from,to).all<{day:string;status:string}>(),
      this.sql.prepare('SELECT id,entry_key,name,mime,note,created_at FROM entry_attachments WHERE user_id=? ORDER BY id DESC LIMIT 501').bind(user).all<{id:number;entry_key:string;name:string;mime:string;note:string;created_at:string}>(),
      this.closing(db,user,to.slice(0,7),today),this.revision(user),
    ]);
    return {views:views.results.map(v=>({...v,settings:JSON.parse(v.settings)})),rules,history,days:days.results,attachments:attachments.results.slice(0,500),attachmentsTruncated:attachments.results.length>500,closing,revision};
  }
  async entry(user:number,kind:string,id:number){
    if(!['expense','income'].includes(kind))throw new WorkspaceError('Attach receipts to an expense or income entry.');
    const table=kind==='expense'?'transactions':'income',row=await this.sql.prepare(`SELECT * FROM ${table} WHERE user_id=? AND id=?`).bind(user,id).first<Record<string,unknown>>();
    if(!row)throw new WorkspaceError('Entry no longer exists. Refresh your records.');
    const key=row.source_chat===null?`${kind}:${id}`:`channel:${row.source_chat}:${row.source_message}:${kind}:${normalize(String(row.note??row.source))}`;
    return {row,key};
  }
}
