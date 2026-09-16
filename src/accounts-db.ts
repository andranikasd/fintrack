import type { Database } from './database';
export interface Account {
  id:number;user_id:number;name:string;opening_minor:number;opening_on:string;
  passive_income:number;archived:number;version:number;balance_minor:number;
}
export class AccountsDb {
  constructor(private readonly db:Database) {}
  async list(user:number,today:string):Promise<Account[]> {
    return (await this.db.prepare(`SELECT a.*,COALESCE((SELECT balance_minor FROM account_daily_balances b WHERE b.account_id=a.id AND b.day<=? ORDER BY b.day DESC LIMIT 1),a.opening_minor) AS balance_minor
      FROM accounts a WHERE a.user_id=? ORDER BY a.archived,lower(a.name)`).bind(today,user).all<Account>()).results;
  }
  /** An omitted account is unambiguous only when exactly one active account exists. */
  async resolve(user:number,account:number|null=null):Promise<number> {
    if (account !== null) {
      const row=await this.get(user,account);
      if (!row || row.archived) throw new Error('Choose an active account owned by you.');
      return row.id;
    }
    const rows=(await this.db.prepare('SELECT id FROM accounts WHERE user_id=? AND archived=0 LIMIT 2').bind(user).all<{id:number}>()).results;
    if(rows.length!==1) throw new Error('Choose an account first. Use /account to create one, then include @ Account.');
    return rows[0]!.id;
  }
  /** Check before a Telegram write; SQL triggers remain the atomic final guard. */
  async assertCanSpend(user:number,id:number,amountMinor:number,day:string):Promise<void> {
    const account=await this.get(user,id);
    if(!account || account.archived) throw new Error('Choose an active account owned by you.');
    if(day<account.opening_on) return;
    const atDay=(await this.list(user,day)).find(a=>a.id===id)!.balance_minor;
    const later=await this.db.prepare('SELECT MIN(balance_minor) AS balance FROM account_daily_balances WHERE account_id=? AND day>=?').bind(id,day).first<{balance:number|null}>();
    const available=Math.min(atDay,later?.balance??atDay);
    if(amountMinor>available) throw new Error(`Insufficient funds in ${account.name}. Available for this date: ${(Math.max(0,available)/100).toLocaleString('en-US')} AMD. Choose another account or correct the amount.`);
  }
  /** Suggest an owned active account from recorded history; never book a choice automatically. */
  async suggest(user:number,kind:'expense'|'income'|'saving'|'withdrawal',label:string,categoryId:number|null=null):Promise<number|null> {
    const table=kind==='expense'?'transactions':kind==='income'?'income':'savings';
    const name=kind==='expense'?'t.note':kind==='income'?'t.source':'g.name';
    const join=table==='savings'?'JOIN goals g ON g.id=t.goal_id':'';
    const sign=kind==='saving'?'AND t.amount_minor>0':kind==='withdrawal'?'AND t.amount_minor<0':'';
    const category=kind==='expense'?'OR t.category_id=?':'';
    const row=await this.db.prepare(`SELECT t.account_id FROM ${table} t JOIN accounts a ON a.id=t.account_id AND a.user_id=t.user_id ${join}
      WHERE t.user_id=? AND a.archived=0 ${sign} AND (lower(trim(${name}))=lower(trim(?)) ${category})
      ORDER BY CASE WHEN lower(trim(${name}))=lower(trim(?)) THEN 0 ELSE 1 END,t.id DESC LIMIT 1`)
      .bind(user,label,...(kind==='expense'?[categoryId]:[]),label).first<{account_id:number}>();
    return row?.account_id??null;
  }
  async get(user:number,id:number) { return this.db.prepare('SELECT * FROM accounts WHERE user_id=? AND id=?').bind(user,id).first<Account>(); }
  async create(user:number,name:string,openingMinor:number,openingOn:string,eventKey:string) {
    return (await this.db.prepare('INSERT OR IGNORE INTO accounts(user_id,name,opening_minor,opening_on,event_key) VALUES(?,?,?,?,?)').bind(user,name,openingMinor,openingOn,eventKey).run()).meta.changes === 1;
  }
  async named(user:number,name:string,includeArchived=false) { return this.db.prepare(`SELECT a.* FROM accounts a WHERE a.user_id=?
    AND (a.name=? COLLATE NOCASE OR a.id IN(SELECT account_id FROM account_names WHERE user_id=? AND name=? COLLATE NOCASE))
    AND (?=1 OR a.archived=0)`).bind(user,name,user,name,includeArchived?1:0).first<Account>(); }
  async aliases(user:number) {return (await this.db.prepare('SELECT name,account_id FROM account_names WHERE user_id=?').bind(user).all<{name:string;account_id:number}>()).results;}
}
