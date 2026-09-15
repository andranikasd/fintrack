import type { Database } from './database';
export interface Account {
  id:number;user_id:number;name:string;opening_minor:number;opening_on:string;
  passive_income:number;archived:number;version:number;balance_minor:number;
}
export class AccountsDb {
  constructor(private readonly db:Database) {}
  async list(user:number,today:string):Promise<Account[]> {
    return (await this.db.prepare(`SELECT a.*,
      a.opening_minor + COALESCE((SELECT SUM(i.amount_minor) FROM income i WHERE i.user_id=a.user_id AND i.account_id=a.id AND i.received_on BETWEEN a.opening_on AND ?),0)
      - COALESCE((SELECT SUM(t.amount)*100 FROM transactions t WHERE t.user_id=a.user_id AND t.account_id=a.id AND t.spent_on BETWEEN a.opening_on AND ?),0) AS balance_minor
      FROM accounts a WHERE a.user_id=? ORDER BY a.archived,lower(a.name)`).bind(today,today,user).all<Account>()).results;
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
