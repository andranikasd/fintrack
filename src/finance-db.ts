import { AccountsDb } from './accounts-db';
import type { Database, Statement } from './database';
import type { Goal } from './lib/savings';
export interface Preferences { funding: 'shared' | 'separate'; reserve_minor: number; reminder_time: string | null; summary_time: string | null; }
export interface SyncedRow { categoryId: number | null; label: string; amount: number; goalId?: number; income?: boolean; accountId?:number|null; passive?:boolean; accountName?:string; }
export interface Channel { chat_id: number; user_id: number; title: string; }
export interface Reminder { id: number; user_id: number; goal_id: number; day: string; amount_minor: number; status: string; }
export class FinanceDb {
  constructor(private readonly db: Database) {}
  async channel(id: number) { return this.db.prepare('SELECT * FROM channels WHERE chat_id = ?').bind(id).first<Channel>(); }
  async link(id: number, user: number, title: string) {
    await this.db.prepare('INSERT INTO channels(chat_id,user_id,title) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title WHERE channels.user_id=excluded.user_id').bind(id,user,title).run();
    return (await this.channel(id))?.user_id === user;
  }
  async channels(user: number) { return (await this.db.prepare('SELECT * FROM channels WHERE user_id=?').bind(user).all<Channel>()).results; }
  async unlink(user: number, chat: number) { await this.db.prepare('DELETE FROM channels WHERE user_id=? AND chat_id=?').bind(user,chat).run(); }
  async post(chat: number, message: number) {
    return this.db.prepare('SELECT * FROM channel_posts WHERE chat_id=? AND message_id=?').bind(chat,message).first<{error: string | null; spent_on: string | null}>();
  }
  async latestPostForDay(user: number, day: string, chat: number) {
    return this.db.prepare(`SELECT chat_id,message_id,spent_on,content FROM channel_posts
      WHERE user_id=? AND spent_on=? AND chat_id=? AND error IS NULL ORDER BY message_id DESC LIMIT 1`).bind(user,day,chat)
      .first<{chat_id:number;message_id:number;spent_on:string;content:string|null}>();
  }
  async errors(user: number) { return (await this.db.prepare('SELECT chat_id,message_id,error FROM channel_posts WHERE user_id=? AND error IS NOT NULL LIMIT 10').bind(user).all<{chat_id:number;message_id:number;error:string}>()).results; }
  /** One D1 transaction: newer revisions replace only their own source records. */
  async syncPost(user: number, chat: number, message: number, version: number, update: number, day: string | null, rows: SyncedRow[], error: string | null, setups: Array<{name:string;amount:number}>=[], managed=false, content:string|null=null) {
    const existing=await this.db.prepare('SELECT user_id,version,update_id FROM channel_posts WHERE chat_id=? AND message_id=?').bind(chat,message).first<{user_id:number;version:number;update_id:number}>();
    if(existing && (existing.user_id!==user || version<existing.version || (version===existing.version && update<=existing.update_id))) return false;
    if(!error) for(const row of rows) {
      if(row.accountName && setups.some(a=>a.name.toLowerCase()===row.accountName!.toLowerCase())) continue;
      row.accountId=await new AccountsDb(this.db).resolve(user,row.accountId??null);
    }
    const nonce = crypto.randomUUID();
    const guard = 'EXISTS(SELECT 1 FROM channel_posts WHERE chat_id=? AND message_id=? AND nonce=?)';
    const statements = [this.db.prepare(`INSERT INTO channel_posts(chat_id,message_id,user_id,version,update_id,nonce,spent_on,error,bot_managed,content)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id,message_id) DO UPDATE SET
      version=excluded.version,update_id=excluded.update_id,nonce=excluded.nonce,
      spent_on=COALESCE(excluded.spent_on,channel_posts.spent_on),error=excluded.error,content=CASE WHEN excluded.error IS NULL THEN COALESCE(excluded.content,channel_posts.content) ELSE channel_posts.content END,bot_managed=MAX(channel_posts.bot_managed,excluded.bot_managed)
      WHERE channel_posts.user_id=excluded.user_id AND (excluded.version > channel_posts.version OR (excluded.version=channel_posts.version AND excluded.update_id>channel_posts.update_id))`)
      .bind(chat,message,user,version,update,nonce,day,error,managed?1:0,content)];
    if (!error) {
      for(const setup of setups) statements.push(this.db.prepare(`INSERT INTO accounts(user_id,name,opening_minor,opening_on,event_key)
        SELECT ?,?,?,?,? WHERE ${guard} ON CONFLICT(user_id,name) DO NOTHING`).bind(user,setup.name,setup.amount,day,`channel-account:${chat}:${message}:${setup.name.toLowerCase()}`,chat,message,nonce));
      statements.push(this.db.prepare(`DELETE FROM transactions WHERE source_chat=? AND source_message=? AND ${guard}`).bind(chat,message,chat,message,nonce));
      statements.push(this.db.prepare(`DELETE FROM savings WHERE source_chat=? AND source_message=? AND ${guard}`).bind(chat,message,chat,message,nonce));
      statements.push(this.db.prepare(`DELETE FROM income WHERE source_chat=? AND source_message=? AND ${guard}`).bind(chat,message,chat,message,nonce));
      for (const row of rows) {
        const account='COALESCE(?,(SELECT id FROM accounts WHERE user_id=? AND name=? COLLATE NOCASE))';
        const accountParams=[row.accountId??null,user,row.accountName??''];
        statements.push(row.income
          ? this.db.prepare(`INSERT INTO income(user_id,source,amount_minor,received_on,source_chat,source_message,account_id,passive) SELECT ?,?,?,?,?,?,${account},? WHERE ${guard}`).bind(user,row.label,row.amount,day,chat,message,...accountParams,row.passive?1:0,chat,message,nonce)
          : row.goalId !== undefined
          ? this.db.prepare(`INSERT INTO savings(user_id,goal_id,amount_minor,saved_on,source_chat,source_message,account_id) SELECT ?,?,?,?,?,?,${account} WHERE ${guard}`).bind(user,row.goalId,row.amount,day,chat,message,...accountParams,chat,message,nonce)
          : this.db.prepare(`INSERT INTO transactions(user_id,category_id,amount,note,spent_on,source_chat,source_message,account_id) SELECT ?,?,?,?,?,?,?,${account} WHERE ${guard}`).bind(user,row.categoryId,row.amount,row.label,day,chat,message,...accountParams,chat,message,nonce));
      }
    }
    if (!error) statements.push(this.db.prepare(`UPDATE goals SET opening_minor=-1
      WHERE user_id=? AND opening_minor+COALESCE((SELECT SUM(amount_minor) FROM savings WHERE goal_id=goals.id),0)<0 AND ${guard}`).bind(user,chat,message,nonce));
    const result = await this.db.batch([
      this.db.prepare('INSERT INTO account_balance_batches(user_id) VALUES(?)').bind(user),
      ...statements,
      this.db.prepare('DELETE FROM account_balance_batches WHERE user_id=?').bind(user),
    ]);
    return (result[1]?.meta.changes ?? 0) > 0;
  }
  async forgetPost(user: number, chat: number, message: number) {
    await this.db.batch([
      this.db.prepare('INSERT INTO account_balance_batches(user_id) VALUES(?)').bind(user),
      this.db.prepare('DELETE FROM transactions WHERE user_id=? AND source_chat=? AND source_message=?').bind(user,chat,message),
      this.db.prepare('DELETE FROM savings WHERE user_id=? AND source_chat=? AND source_message=?').bind(user,chat,message),
      this.db.prepare('DELETE FROM income WHERE user_id=? AND source_chat=? AND source_message=?').bind(user,chat,message),
      this.db.prepare('UPDATE channel_posts SET error=NULL,spent_on=NULL,content=NULL,bot_managed=0 WHERE user_id=? AND chat_id=? AND message_id=?').bind(user,chat,message),
      this.db.prepare('UPDATE goals SET opening_minor=-1 WHERE user_id=? AND opening_minor+COALESCE((SELECT SUM(amount_minor) FROM savings WHERE goal_id=goals.id),0)<0').bind(user),
      this.db.prepare('DELETE FROM account_balance_batches WHERE user_id=?').bind(user),
    ]);
  }
  async preferences(user: number): Promise<Preferences> {
    return await this.db.prepare('SELECT funding,reserve_minor,reminder_time,summary_time FROM finance_preferences WHERE user_id=?').bind(user).first<Preferences>() ?? { funding:'separate', reserve_minor:0, reminder_time:null, summary_time:null };
  }
  async setFunding(user: number, funding: string, reserve: number) {
    await this.db.prepare('INSERT INTO finance_preferences(user_id,funding,reserve_minor) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET funding=excluded.funding,reserve_minor=excluded.reserve_minor').bind(user,funding,reserve).run();
  }
  async setTime(user: number, kind: 'reminder' | 'summary', time: string | null) {
    const column = kind === 'reminder' ? 'reminder_time' : 'summary_time';
    await this.db.prepare(`INSERT INTO finance_preferences(user_id,${column}) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET ${column}=excluded.${column}`).bind(user,time).run();
  }
  async goals(user: number): Promise<Goal[]> {
    return (await this.db.prepare(`SELECT g.*,g.opening_minor+COALESCE(SUM(s.amount_minor),0) AS saved_minor FROM goals g LEFT JOIN savings s ON s.goal_id=g.id WHERE g.user_id=? GROUP BY g.id ORDER BY g.id`).bind(user).all<Goal>()).results;
  }
  async putGoal(user: number, name: string, target: number, deadline: string | null, daily: number | null, opening: number, cap: number | null) {
    // Updating a plan never rewrites its existing opening balance or contribution history.
    await this.db.prepare(`INSERT INTO goals(user_id,name,target_minor,deadline,daily_minor,opening_minor,cap_minor) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(user_id,name) DO UPDATE SET target_minor=excluded.target_minor,deadline=excluded.deadline,daily_minor=excluded.daily_minor,cap_minor=excluded.cap_minor`).bind(user,name,target,deadline,daily,opening,cap).run();
  }
  async contribute(user: number, goal: number, amount: number, day: string, event: string, account: number|null=null) {
    if(!await this.db.prepare('SELECT id FROM goals WHERE id=? AND user_id=?').bind(goal,user).first()) return false;
    account=await new AccountsDb(this.db).resolve(user,account);
    const result = await this.db.prepare(`INSERT OR IGNORE INTO savings(user_id,goal_id,amount_minor,saved_on,event_key,account_id)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM goals WHERE id=? AND user_id=?)
      AND (? > 0 OR (SELECT opening_minor + COALESCE((SELECT SUM(amount_minor) FROM savings WHERE goal_id=?),0) FROM goals WHERE id=?) >= -?)`)
      .bind(user,goal,amount,day,event,account,goal,user,amount,goal,goal,amount).run();
    return (result.meta.changes ?? 0) > 0;
  }
  async goalSavingsOn(user: number, day: string) {
    return (await this.db.prepare('SELECT goal_id,SUM(amount_minor) AS total FROM savings WHERE user_id=? AND saved_on=? GROUP BY goal_id').bind(user,day).all<{goal_id:number;total:number}>()).results;
  }
  async savingsEntries(user: number, from: string, to: string) {
    return (await this.db.prepare(`SELECT s.*,g.name AS goal_name FROM savings s JOIN goals g ON g.id=s.goal_id
      WHERE s.user_id=? AND s.saved_on BETWEEN ? AND ? ORDER BY s.saved_on DESC,s.id DESC LIMIT 10001`)
      .bind(user,from,to).all<{id:number;goal_id:number;goal_name:string;amount_minor:number;account_id:number;saved_on:string;source_chat:number|null}>()).results;
  }
  async savingsByDay(user: number, from: string, to: string) {
    return (await this.db.prepare(`SELECT saved_on AS day,SUM(CASE WHEN amount_minor>0 THEN amount_minor ELSE 0 END) AS deposits,
      SUM(CASE WHEN amount_minor<0 THEN -amount_minor ELSE 0 END) AS withdrawals FROM savings WHERE user_id=? AND saved_on BETWEEN ? AND ? GROUP BY saved_on ORDER BY saved_on`).bind(user,from,to).all<{day:string;deposits:number;withdrawals:number}>()).results;
  }
  async savingsTotal(user: number, from: string, to: string) {
    return (await this.db.prepare('SELECT COALESCE(SUM(amount_minor),0) AS total FROM savings WHERE user_id=? AND saved_on BETWEEN ? AND ?').bind(user,from,to).first<{total:number}>())?.total ?? 0;
  }
  async alias(user: number, label: string, category: number) {
    await this.db.prepare('INSERT INTO aliases(user_id,label,category_id) VALUES(?,?,?) ON CONFLICT(user_id,label) DO UPDATE SET category_id=excluded.category_id').bind(user,label,category).run();
    await this.db.prepare('UPDATE transactions SET category_id=? WHERE user_id=? AND lower(note)=lower(?) AND source_chat IS NOT NULL').bind(category,user,label).run();
  }
  async aliases(user: number) { return (await this.db.prepare('SELECT label,category_id FROM aliases WHERE user_id=?').bind(user).all<{label:string;category_id:number}>()).results; }
  async reminder(user: number, goal: number, day: string, amount: number): Promise<Reminder> {
    await this.db.prepare('INSERT OR IGNORE INTO reminders(user_id,goal_id,day,amount_minor,baseline_minor) SELECT ?,?,?,?,COALESCE(SUM(amount_minor),0) FROM savings WHERE user_id=? AND goal_id=? AND saved_on=?').bind(user,goal,day,amount,user,goal,day).run();
    return (await this.db.prepare('SELECT * FROM reminders WHERE user_id=? AND goal_id=? AND day=?').bind(user,goal,day).first<Reminder>())!;
  }
  async getReminder(user: number, id: number) { return this.db.prepare('SELECT * FROM reminders WHERE user_id=? AND id=?').bind(user,id).first<Reminder>(); }
  async resolveReminder(user: number, id: number, amount: number | null, account: number|null=null) {
    const reminder=await this.getReminder(user,id);
    if(!reminder || reminder.status!=='pending') return false;
    if(amount!==null) {
      if(!Number.isSafeInteger(amount)||amount<=0) throw new Error('Enter a positive savings amount.');
      account=await new AccountsDb(this.db).resolve(user,account);
    }
    const statements: Statement[] = [];
    if (amount !== null) statements.push(this.db.prepare(`INSERT OR IGNORE INTO savings(user_id,goal_id,amount_minor,saved_on,event_key,account_id)
      SELECT user_id,goal_id,?,day,'reminder:'||id,? FROM reminders r WHERE user_id=? AND id=? AND status='pending' AND baseline_minor=COALESCE((SELECT SUM(amount_minor) FROM savings s WHERE s.user_id=r.user_id AND s.goal_id=r.goal_id AND s.saved_on=r.day),0)`).bind(amount,account,user,id));
    statements.push(this.db.prepare("UPDATE reminders SET status=? WHERE user_id=? AND id=? AND status='pending' AND (?=1 OR EXISTS(SELECT 1 FROM savings WHERE event_key='reminder:'||reminders.id))").bind(amount === null ? 'skipped' : 'saved',user,id,amount===null?1:0));
    return ((await this.db.batch(statements)).at(-1)?.meta.changes ?? 0) > 0;
  }
  async claimDelivery(user: number, day: string, kind: string, now: number) {
    return ((await this.db.prepare(`INSERT INTO deliveries(user_id,day,kind,lease_until) VALUES(?,?,?,?)
      ON CONFLICT(user_id,day,kind) DO UPDATE SET lease_until=excluded.lease_until WHERE deliveries.status='pending' AND deliveries.lease_until<?`).bind(user,day,kind,now+300,now).run()).meta.changes ?? 0) > 0;
  }
  async finishDelivery(user: number, day: string, kind: string, success: boolean) {
    await this.db.prepare('UPDATE deliveries SET status=?,lease_until=0 WHERE user_id=? AND day=? AND kind=?').bind(success?'sent':'pending',user,day,kind).run();
  }
}
