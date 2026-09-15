import { AccountsDb } from './accounts-db';
import type { Database } from './database';

export interface Income {
  id: number;
  user_id: number;
  source: string;
  account_id: number | null;
  passive: number;
  amount_minor: number;
  received_on: string;
  source_chat: number | null;
  source_message: number | null;
}

export class IncomeDb {
  constructor(private readonly db: Database) {}

  async add(user: number, source: string, amount: number, day: string, event: string, account: number | null = null, passive = false): Promise<boolean> {
    account = await new AccountsDb(this.db).resolve(user,account);
    const result = await this.db.prepare(`INSERT OR IGNORE INTO income
      (user_id,source,amount_minor,received_on,event_key,account_id,passive) VALUES(?,?,?,?,?,?,?)`)
      .bind(user,source,amount,day,event,account,passive?1:0).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async total(user: number, from: string, to: string): Promise<number> {
    return (await this.db.prepare('SELECT COALESCE(SUM(amount_minor),0) AS total FROM income WHERE user_id=? AND received_on BETWEEN ? AND ?')
      .bind(user,from,to).first<{total:number}>())?.total ?? 0;
  }

  async list(user: number, from: string, to: string, limit = 10001): Promise<Income[]> {
    return (await this.db.prepare('SELECT * FROM income WHERE user_id=? AND received_on BETWEEN ? AND ? ORDER BY received_on DESC,id DESC LIMIT ?')
      .bind(user,from,to,limit).all<Income>()).results;
  }

  async bySource(user: number, from: string, to: string) {
    return (await this.db.prepare('SELECT source,SUM(amount_minor) AS total FROM income WHERE user_id=? AND received_on BETWEEN ? AND ? GROUP BY lower(source) ORDER BY total DESC')
      .bind(user,from,to).all<{source:string;total:number}>()).results;
  }

  async remove(user: number, id: number): Promise<boolean> {
    return ((await this.db.prepare('DELETE FROM income WHERE user_id=? AND id=? AND source_chat IS NULL').bind(user,id).run()).meta.changes ?? 0) > 0;
  }
}
