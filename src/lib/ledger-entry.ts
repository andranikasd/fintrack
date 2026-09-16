import type { Db } from '../db';
import type { Database } from '../database';
export type EntryKind='expense'|'income'|'saving'|'withdrawal';
export interface LedgerEntry {id:number;kind:EntryKind;amount:number;label:string;categoryId:number|null;accountId:number;day:string;passive:boolean;goalId?:number;sourceChat:number|null;sourceMessage:number|null}
export async function ledgerEntry(db:Db,sql:Database,user:number,kind:EntryKind,id:number):Promise<LedgerEntry|null>{
  if(kind==='expense'){
    const r=await db.transaction(user,id);return r?{id,kind,amount:r.amount*100,label:r.note,categoryId:r.category_id,accountId:r.account_id!,day:r.spent_on,passive:false,sourceChat:r.source_chat??null,sourceMessage:r.source_message??null}:null;
  }
  if(kind==='income'){
    const r=await sql.prepare('SELECT * FROM income WHERE user_id=? AND id=?').bind(user,id).first<{amount_minor:number;source:string;account_id:number;received_on:string;passive:number;source_chat:number|null;source_message:number|null}>();
    return r?{id,kind,amount:r.amount_minor,label:r.source,categoryId:null,accountId:r.account_id,day:r.received_on,passive:Boolean(r.passive),sourceChat:r.source_chat,sourceMessage:r.source_message}:null;
  }
  const r=await sql.prepare('SELECT s.*,g.name FROM savings s JOIN goals g ON g.id=s.goal_id WHERE s.user_id=? AND s.id=?').bind(user,id).first<{amount_minor:number;goal_id:number;account_id:number;saved_on:string;name:string;source_chat:number|null;source_message:number|null}>();
  if(!r||(kind==='saving')!==(r.amount_minor>0))return null;
  return {id,kind,amount:Math.abs(r.amount_minor),label:r.name,categoryId:null,accountId:r.account_id,day:r.saved_on,passive:false,goalId:r.goal_id,sourceChat:r.source_chat,sourceMessage:r.source_message};
}
export function matchesEntry(row:LedgerEntry,expected:Record<string,unknown>):boolean{
  return Boolean(expected)&&row.amount===expected.amountMinor&&row.accountId===expected.accountId&&row.label===expected.label&&row.day===expected.day&&Boolean(row.passive)===Boolean(expected.passive)&&(expected.goalId===undefined||row.goalId===expected.goalId)&&(expected.categoryId===undefined||row.categoryId===expected.categoryId);
}
export async function correctSaving(db:Db,sql:Database,user:number,kind:'saving'|'withdrawal',id:number,expected:Record<string,unknown>,next:{amount:number;accountId:number;goalId:number;day:string}|null):Promise<void>{
  const row=await ledgerEntry(db,sql,user,kind,id);
  if(!row||!matchesEntry(row,expected))throw new Error('This savings entry changed. Reopen it.');
  if(row.sourceChat!==null)throw new Error('Correct this entry in its source table.');
  const signed=row.amount*(kind==='saving'?1:-1);
  const guard='user_id=? AND id=? AND source_chat IS NULL AND amount_minor=? AND account_id=? AND goal_id=? AND saved_on=?';
  const values=[user,id,signed,row.accountId,row.goalId!,row.day];
  if(next){await db.accounts.resolve(user,next.accountId);if(!(await db.finance.goals(user)).some(g=>g.id===next.goalId))throw new Error('Choose your savings goal.');}
  const result=next?await sql.prepare(`UPDATE savings SET amount_minor=?,account_id=?,goal_id=?,saved_on=? WHERE ${guard}`).bind(next.amount*(kind==='saving'?1:-1),next.accountId,next.goalId,next.day,...values).run():await sql.prepare(`DELETE FROM savings WHERE ${guard}`).bind(...values).run();
  if(!result.meta.changes)throw new Error('This savings entry changed. Reopen it.');
}
