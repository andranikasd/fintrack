import type { Database } from './database';
import { AccountsDb } from './accounts-db';
import { validDate } from './lib/savings';
import { addDays } from './lib/dates';
export interface Bill {id:number;user_id:number;label:string;amount_minor:number;account_id:number;category_id:number|null;frequency:'weekly'|'monthly';anchor_day:number;next_due:string;remind_time:string;enabled:number;version:number;event_key:string}
export interface BillOccurrence {id:number;user_id:number;rule_id:number;rule_version:number;due_on:string;label:string;amount_minor:number;account_id:number;category_id:number|null;status:string;transaction_id:number|null}
export function nextBillDate(day:string,frequency:'weekly'|'monthly',anchor:number):string{
  if(frequency==='weekly')return addDays(day,7);
  const next=new Date(Date.UTC(Number(day.slice(0,4)),Number(day.slice(5,7)),1));
  const last=new Date(Date.UTC(next.getUTCFullYear(),next.getUTCMonth()+1,0)).getUTCDate();
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth()+1).padStart(2,'0')}-${String(Math.min(anchor,last)).padStart(2,'0')}`;
}
export class BillsDb {
  constructor(private readonly sql:Database){}
  async list(user:number){return (await this.sql.prepare('SELECT * FROM recurring_bills WHERE user_id=? ORDER BY enabled DESC,next_due,id').bind(user).all<Bill>()).results;}
  async get(user:number,id:number){return this.sql.prepare('SELECT * FROM recurring_bills WHERE user_id=? AND id=?').bind(user,id).first<Bill>();}
  async occurrence(user:number,id:number){return this.sql.prepare('SELECT * FROM bill_occurrences WHERE user_id=? AND id=?').bind(user,id).first<BillOccurrence>();}
  async save(user:number,input:Omit<Bill,'id'|'user_id'|'version'|'event_key'|'anchor_day'>,event:string,id?:number,version?:number):Promise<number>{
    if(!input.label.trim()||input.label.length>120)throw new Error('Enter a bill name of 1–120 characters.');
    if(!Number.isSafeInteger(input.amount_minor)||input.amount_minor<=0||input.amount_minor%100||input.amount_minor>100000000000)throw new Error('Bill amounts must be positive whole drams.');
    if(!validDate(input.next_due)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.remind_time))throw new Error('Choose a valid date and reminder time.');
    if(!['weekly','monthly'].includes(input.frequency))throw new Error('Choose weekly or monthly.');
    await new AccountsDb(this.sql).resolve(user,input.account_id);
    if(input.category_id!==null&&!await this.sql.prepare('SELECT id FROM categories WHERE user_id=? AND id=? AND archived=0').bind(user,input.category_id).first())throw new Error('Choose an active category.');
    const current=id?await this.get(user,id):null;
    if(id&&(!current||current.version!==version))throw new Error('This bill changed. Reopen it.');
    const anchor=current&&current.next_due===input.next_due?current.anchor_day:Number(input.next_due.slice(8));
    const values=[input.label.trim(),input.amount_minor,input.account_id,input.category_id,input.frequency,anchor,input.next_due,input.remind_time,input.enabled?1:0];
    if(!id){const row=await this.sql.prepare('INSERT INTO recurring_bills(user_id,label,amount_minor,account_id,category_id,frequency,anchor_day,next_due,remind_time,enabled,event_key) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET event_key=excluded.event_key RETURNING id').bind(user,...values,event).first<{id:number}>();return row!.id;}
    const guard=crypto.randomUUID();
    try{await this.sql.batch([
      this.sql.prepare('INSERT INTO mutation_guards(id,expected,actual) VALUES(?,?,COALESCE((SELECT version FROM recurring_bills WHERE user_id=? AND id=?),0))').bind(guard,version,user,id),
      this.sql.prepare('UPDATE recurring_bills SET label=?,amount_minor=?,account_id=?,category_id=?,frequency=?,anchor_day=?,next_due=?,remind_time=?,enabled=?,version=version+1 WHERE user_id=? AND id=?').bind(...values,user,id),
      this.sql.prepare("UPDATE bill_occurrences SET status='cancelled' WHERE user_id=? AND rule_id=? AND status='pending'").bind(user,id),
      this.sql.prepare('DELETE FROM mutation_guards WHERE id=?').bind(guard),
    ]);}catch(error){if(error instanceof Error&&/expected=actual/.test(error.message))throw new Error('This bill changed. Reopen it.');throw error;}
    return id;
  }
  async due(user:number,today:string,time:string):Promise<BillOccurrence[]>{
    await this.sql.prepare(`INSERT OR IGNORE INTO bill_occurrences(user_id,rule_id,rule_version,due_on,label,amount_minor,account_id,category_id)
      SELECT user_id,id,version,next_due,label,amount_minor,account_id,category_id FROM recurring_bills WHERE user_id=? AND enabled=1 AND next_due<=? AND remind_time<=?`).bind(user,today,time).run();
    return (await this.sql.prepare(`SELECT o.* FROM bill_occurrences o JOIN recurring_bills b ON b.id=o.rule_id AND b.user_id=o.user_id AND b.version=o.rule_version WHERE o.user_id=? AND o.status='pending' AND b.enabled=1 AND o.due_on<=? AND b.remind_time<=? ORDER BY o.due_on,o.id LIMIT 50`).bind(user,today,time).all<BillOccurrence>()).results;
  }
  async matches(user:number,o:BillOccurrence,day:string){return (await this.sql.prepare('SELECT id FROM transactions WHERE user_id=? AND amount=? AND spent_on=? AND lower(trim(note))=lower(trim(?)) ORDER BY id DESC LIMIT 5').bind(user,o.amount_minor/100,day,o.label).all<{id:number}>()).results;}
  /** Resolve the occurrence and advance its rule in the same transaction as the expense. */
  async resolve(user:number,id:number,day:string,mode:'paid'|'skip',existingId?:number):Promise<number|null>{
    const o=await this.occurrence(user,id);if(!o||o.status!=='pending')return null;
    const bill=await this.get(user,o.rule_id);if(!bill||!bill.enabled||bill.version!==o.rule_version)throw new Error('This reminder changed. Open /bills.');
    if(!validDate(day))throw new Error('Choose a valid date.');
    if(existingId&&!((await this.matches(user,o,day)).some(r=>r.id===existingId)))throw new Error('The matching expense changed. Open /bills.');
    const next=nextBillDate(o.due_on,bill.frequency,bill.anchor_day),guard=crypto.randomUUID(),event=`bill:${user}:${id}`;
    const statements=[this.sql.prepare(`INSERT INTO mutation_guards(id,expected,actual) VALUES(?,1,(SELECT COUNT(*) FROM bill_occurrences o JOIN recurring_bills b ON b.id=o.rule_id AND b.user_id=o.user_id WHERE o.user_id=? AND o.id=? AND o.status='pending' AND b.enabled=1 AND b.version=o.rule_version))`).bind(guard,user,id)];
    if(mode==='paid'&&existingId)statements.push(this.sql.prepare(`INSERT INTO mutation_guards(id,expected,actual)
      VALUES(?,1,(SELECT COUNT(*) FROM transactions WHERE user_id=? AND id=? AND amount=? AND spent_on=? AND lower(trim(note))=lower(trim(?))))`)
      .bind(guard+':expense',user,existingId,o.amount_minor/100,day,o.label));
    if(mode==='paid'&&!existingId)statements.push(this.sql.prepare('INSERT INTO transactions(user_id,amount,note,spent_on,account_id,category_id,dashboard_event) VALUES(?,?,?,?,?,?,?)').bind(user,o.amount_minor/100,o.label,day,o.account_id,o.category_id,event));
    statements.push(this.sql.prepare("UPDATE bill_occurrences SET status=?,transaction_id=COALESCE(?,(SELECT id FROM transactions WHERE user_id=? AND dashboard_event=?)) WHERE user_id=? AND id=?").bind(mode==='paid'?'paid':'skipped',existingId??null,user,event,user,id),
      this.sql.prepare('UPDATE recurring_bills SET next_due=?,version=version+1 WHERE user_id=? AND id=?').bind(next,user,bill.id),
      this.sql.prepare('DELETE FROM mutation_guards WHERE id IN (?,?)').bind(guard,guard+':expense'));
    try{await this.sql.batch(statements);}catch(error){if(error instanceof Error&&/expected=actual/.test(error.message))return null;throw error;}
    return mode==='paid'?(await this.occurrence(user,id))!.transaction_id:0;
  }
}
