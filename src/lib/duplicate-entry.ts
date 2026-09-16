import type { Database } from '../database';
import type { EntryKind } from './ledger-entry';
export async function duplicateEntries(sql:Database,user:number,entry:{kind:EntryKind;amount:number;label:string;day:string;goalId?:number}){
  const table=entry.kind==='expense'?'transactions':entry.kind==='income'?'income':'savings';
  const amountColumn=entry.kind==='expense'?'amount':'amount_minor',dayColumn=entry.kind==='expense'?'spent_on':entry.kind==='income'?'received_on':'saved_on';
  const nameColumn=entry.kind==='expense'?'note':'source';
  const amount=entry.kind==='expense'?entry.amount/100:entry.kind==='withdrawal'?-entry.amount:entry.amount;
  const savings=entry.kind==='saving'||entry.kind==='withdrawal';
  return (await sql.prepare(`SELECT id,account_id FROM ${table} WHERE user_id=? AND ${dayColumn}=? AND ${amountColumn}=? AND ${savings?'goal_id=?':`lower(trim(${nameColumn}))=lower(trim(?))`} ORDER BY id DESC LIMIT 5`).bind(user,entry.day,amount,savings?entry.goalId??0:entry.label).all<{id:number;account_id:number}>()).results;
}
export function duplicateSignature(entry:{kind:EntryKind;amount?:number;label?:string;day:string;accountId?:number;goalId?:number;categoryId?:number|null},ids:number[]){return JSON.stringify([entry.kind,entry.amount,entry.label,entry.day,entry.accountId,entry.goalId,entry.categoryId,ids]);}
