import type { Database } from './database';
import { AccountsDb } from './accounts-db';
import { validDate } from './lib/savings';
export interface Transfer {id:number;user_id:number;from_account_id:number;to_account_id:number;amount_minor:number;transferred_on:string;note:string;event_key:string;from_name:string;to_name:string}
export class TransfersDb {
  constructor(private readonly sql:Database){}
  async list(user:number,from='0001-01-01',to='9999-12-31'){
    return (await this.sql.prepare(`SELECT t.*,a.name AS from_name,b.name AS to_name FROM account_transfers t JOIN accounts a ON a.id=t.from_account_id JOIN accounts b ON b.id=t.to_account_id WHERE t.user_id=? AND t.transferred_on BETWEEN ? AND ? ORDER BY t.transferred_on DESC,t.id DESC LIMIT 10001`).bind(user,from,to).all<Transfer>()).results;
  }
  async add(user:number,from:number,to:number,amount:number,day:string,note:string,event:string,today:string):Promise<number>{
    if(!Number.isSafeInteger(amount)||amount<=0||amount>100000000000)throw new Error('Enter a positive amount.');
    if(!validDate(day)||day>today)throw new Error('Choose today or a past date.');
    if(from===to)throw new Error('Choose two different accounts.');
    const accounts=new AccountsDb(this.sql);await accounts.resolve(user,from);await accounts.resolve(user,to);
    if(note.length>120)throw new Error('Use a note of at most 120 characters.');
    const existing=await this.sql.prepare('SELECT id FROM account_transfers WHERE user_id=? AND event_key=?').bind(user,event).first<{id:number}>();
    if(existing)return existing.id;
    const row=await this.sql.prepare('INSERT INTO account_transfers(user_id,from_account_id,to_account_id,amount_minor,transferred_on,note,event_key) VALUES(?,?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET event_key=excluded.event_key RETURNING id').bind(user,from,to,amount,day,note,event).first<{id:number}>();
    return row!.id;
  }
  async remove(user:number,id:number){return (await this.sql.prepare('DELETE FROM account_transfers WHERE user_id=? AND id=?').bind(user,id).run()).meta.changes===1;}
}
