import { WorkspaceDb } from './workspace-db';
import { AccountsDb } from './accounts-db';
import { IncomeDb } from './income-db';
import type { Database, Statement } from './database';
import { FinanceDb } from './finance-db';
import type { Budget, Category, CategoryTotal, TxWithCategory } from './types';

export const OVERALL = 0; // budgets.category_id sentinel for the whole month

const DEFAULT_CATEGORIES: Array<[string, string]> = [
  ['Groceries', '🛒'],
  ['Cafe', '☕'],
  ['Food', '🍽'],
  ['Transport', '🚕'],
  ['Rent', '🏠'],
  ['Utilities', '💡'],
  ['Health', '💊'],
  ['Shopping', '🛍'],
  ['Fun', '🎬'],
  ['Other', '📦'],
];

export class Db {
  readonly workspace: WorkspaceDb;
  readonly finance: FinanceDb;
  readonly income: IncomeDb;
  readonly accounts: AccountsDb;
  constructor(
    private readonly d1: Database,
    private readonly defaultTz: string,
  ) { this.finance = new FinanceDb(d1); this.income = new IncomeDb(d1); this.accounts = new AccountsDb(d1); this.workspace = new WorkspaceDb(d1); }

  async ensureUser(userId: number): Promise<string> {
    const existing = await this.d1
      .prepare('SELECT tz FROM users WHERE id = ?')
      .bind(userId)
      .first<{ tz: string }>();
    if (existing) return existing.tz;

    const statements: Statement[] = [
      this.d1.prepare('INSERT OR IGNORE INTO users (id, tz) VALUES (?, ?)').bind(userId, this.defaultTz),
    ];
    DEFAULT_CATEGORIES.forEach(([name, emoji], i) => {
      statements.push(
        this.d1
          .prepare('INSERT OR IGNORE INTO categories (user_id, name, emoji, sort) VALUES (?, ?, ?, ?)')
          .bind(userId, name, emoji, i),
      );
    });
    await this.d1.batch(statements);
    return this.defaultTz;
  }

  /** Consume a short-lived confirmation in the same transaction as the wipe. */
  async cleanup(userId:number,token:string):Promise<boolean> {
    const guard="EXISTS(SELECT 1 FROM sessions WHERE user_id=? AND state='cleanup' AND json_extract(payload,'$.token')=? AND json_extract(payload,'$.expires')>?)";
    const now=Date.now();
    const tables=['channel_add_requests','dashboard_tokens','channels','transactions','income','savings','reminders','deliveries','balance_checks','account_names','accounts','goals','aliases','budgets','alerts','categories','finance_preferences','channel_posts','entry_attachments','saved_views','logging_days','month_reviews','change_history','finance_revisions'];
    const statements=tables.map(table=>this.d1.prepare(`DELETE FROM ${table} WHERE user_id=? AND ${guard}`).bind(userId,userId,token,now));
    statements.push(this.d1.prepare(`DELETE FROM users WHERE id=? AND ${guard}`).bind(userId,userId,token,now));
    statements.push(this.d1.prepare(`DELETE FROM sessions WHERE user_id=? AND ${guard}`).bind(userId,userId,token,now));
    return ((await this.d1.batch(statements)).at(-1)?.meta.changes??0)>0;
  }

  async setTz(userId: number, tz: string): Promise<void> {
    await this.d1.prepare('UPDATE users SET tz = ? WHERE id = ?').bind(tz, userId).run();
  }

  async listUsers(): Promise<Array<{ id: number; tz: string }>> {
    const { results } = await this.d1
      .prepare('SELECT id, tz FROM users')
      .all<{ id: number; tz: string }>();
    return results ?? [];
  }

  // ---------------------------------------------------------------- categories

  async categories(userId: number, includeArchived = false): Promise<Category[]> {
    const sql = includeArchived
      ? 'SELECT * FROM categories WHERE user_id = ? ORDER BY archived, sort, lower(name)'
      : 'SELECT * FROM categories WHERE user_id = ? AND archived = 0 ORDER BY sort, lower(name)';
    const { results } = await this.d1.prepare(sql).bind(userId).all<Category>();
    return results ?? [];
  }

  async category(userId: number, id: number): Promise<Category | null> {
    return await this.d1
      .prepare('SELECT * FROM categories WHERE user_id = ? AND id = ?')
      .bind(userId, id)
      .first<Category>();
  }

  /** Returns null when a category with that name already exists. */
  async addCategory(userId: number, name: string, emoji: string): Promise<Category | null> {
    const max = await this.d1
      .prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM categories WHERE user_id = ?')
      .bind(userId)
      .first<{ m: number }>();
    try {
      return await this.d1
        .prepare(
          'INSERT INTO categories (user_id, name, emoji, sort) VALUES (?, ?, ?, ?) RETURNING *',
        )
        .bind(userId, name, emoji, (max?.m ?? 0) + 1)
        .first<Category>();
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  async renameCategory(
    userId: number,
    id: number,
    name: string,
    emoji?: string,
  ): Promise<boolean> {
    try {
      const res = emoji === undefined
        ? await this.d1
            .prepare('UPDATE categories SET name = ? WHERE user_id = ? AND id = ?')
            .bind(name, userId, id)
            .run()
        : await this.d1
            .prepare('UPDATE categories SET name = ?, emoji = ? WHERE user_id = ? AND id = ?')
            .bind(name, emoji, userId, id)
            .run();
      return (res.meta.changes ?? 0) > 0;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  async setArchived(userId: number, id: number, archived: boolean): Promise<void> {
    await this.d1
      .prepare('UPDATE categories SET archived = ? WHERE user_id = ? AND id = ?')
      .bind(archived ? 1 : 0, userId, id)
      .run();
  }

  /** Deletes the category and unlinks its transactions (history keeps its amounts). */
  async deleteCategory(userId: number, id: number): Promise<void> {
    await this.d1.batch([
      this.d1
        .prepare('UPDATE transactions SET category_id = NULL WHERE user_id = ? AND category_id = ?')
        .bind(userId, id),
      this.d1.prepare('DELETE FROM budgets WHERE user_id = ? AND category_id = ?').bind(userId, id),
      this.d1.prepare('DELETE FROM aliases WHERE user_id = ? AND category_id = ?').bind(userId, id),
      this.d1.prepare('DELETE FROM categories WHERE user_id = ? AND id = ?').bind(userId, id),
    ]);
  }

  async categoryUsage(userId: number, id: number): Promise<number> {
    const row = await this.d1
      .prepare('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND category_id = ?')
      .bind(userId, id)
      .first<{ c: number }>();
    return row?.c ?? 0;
  }

  // -------------------------------------------------------------- transactions

  async addTransaction(
    userId: number,
    categoryId: number | null,
    amount: number,
    note: string,
    spentOn: string,
    accountId: number | null = null,
    event: string | null = null,
  ): Promise<number> {
    accountId = await this.accounts.resolve(userId,accountId);
    const row = await this.d1
      .prepare(
        'INSERT INTO transactions (user_id, category_id, amount, note, spent_on, account_id, dashboard_event) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dashboard_event) DO UPDATE SET dashboard_event=excluded.dashboard_event RETURNING id',
      )
      .bind(userId, categoryId, amount, note, spentOn, accountId, event)
      .first<{ id: number }>();
    return row!.id;
  }

  async setTransactionCategory(userId: number, txId: number, categoryId: number): Promise<void> {
    await this.d1
      .prepare('UPDATE transactions SET category_id = ? WHERE user_id = ? AND id = ?')
      .bind(categoryId, userId, txId)
      .run();
  }

  async deleteTransaction(userId: number, txId: number): Promise<boolean> {
    const res = await this.d1
      .prepare('DELETE FROM transactions WHERE user_id = ? AND id = ? AND source_chat IS NULL')
      .bind(userId, txId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async lastTransactionId(userId: number): Promise<number | null> {
    const row = await this.d1
      .prepare('SELECT id FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .bind(userId)
      .first<{ id: number }>();
    return row?.id ?? null;
  }

  async transaction(userId: number, txId: number): Promise<TxWithCategory | null> {
    return await this.d1
      .prepare(
        `SELECT t.*, c.name AS category_name, c.emoji AS category_emoji
           FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
          WHERE t.user_id = ? AND t.id = ?`,
      )
      .bind(userId, txId)
      .first<TxWithCategory>();
  }

  async sourceRowsForPost(userId: number, chat: number, message: number) {
    const expenses=(await this.d1.prepare(`SELECT t.note AS label,t.amount,t.account_id,c.name AS category_name
      FROM transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.user_id=? AND t.source_chat=? AND t.source_message=? ORDER BY t.id`).bind(userId,chat,message).all<{label:string;amount:number;account_id:number|null;category_name:string|null}>()).results;
    const income=(await this.d1.prepare('SELECT source AS label,amount_minor,account_id,passive FROM income WHERE user_id=? AND source_chat=? AND source_message=? ORDER BY id').bind(userId,chat,message).all<{label:string;amount_minor:number;account_id:number|null;passive:number}>()).results;
    const savings=(await this.d1.prepare('SELECT g.name AS label,s.amount_minor,s.account_id FROM savings s JOIN goals g ON g.id=s.goal_id WHERE s.user_id=? AND s.source_chat=? AND s.source_message=? ORDER BY s.id').bind(userId,chat,message).all<{label:string;amount_minor:number;account_id:number|null}>()).results;
    return {expenses,income,savings};
  }

  async transactionsBetween(
    userId: number,
    from: string,
    to: string,
    limit = 5000,
  ): Promise<TxWithCategory[]> {
    const { results } = await this.d1
      .prepare(
        `SELECT t.*, c.name AS category_name, c.emoji AS category_emoji
           FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
          WHERE t.user_id = ? AND t.spent_on BETWEEN ? AND ?
          ORDER BY t.spent_on DESC, t.id DESC
          LIMIT ?`,
      )
      .bind(userId, from, to, limit)
      .all<TxWithCategory>();
    return results ?? [];
  }

  /** One picker item per distinct unknown label; unnamed expenses stay separate. */
  async uncategorized(userId: number, day: string | null, offset = 0, limit = 11): Promise<Array<{ id: number; label: string }>> {
    const { results } = await this.d1.prepare(`
      SELECT MIN(id) AS id, note AS label FROM transactions
      WHERE user_id = ? AND category_id IS NULL AND (? IS NULL OR spent_on = ?)
      GROUP BY CASE WHEN note = '' THEN 'tx:' || id ELSE 'label:' || lower(note) END
      ORDER BY lower(note), MIN(id) LIMIT ? OFFSET ?
    `).bind(userId, day, day, limit, offset).all<{ id: number; label: string }>();
    return results;
  }

  async recentTransactions(userId: number, limit: number): Promise<TxWithCategory[]> {
    const { results } = await this.d1
      .prepare(
        `SELECT t.*, c.name AS category_name, c.emoji AS category_emoji
           FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
          WHERE t.user_id = ?
          ORDER BY t.id DESC LIMIT ?`,
      )
      .bind(userId, limit)
      .all<TxWithCategory>();
    return results ?? [];
  }

  // ------------------------------------------------------------------ rollups

  async totalBetween(userId: number, from: string, to: string): Promise<number> {
    const row = await this.d1
      .prepare(
        'SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE user_id = ? AND spent_on BETWEEN ? AND ?',
      )
      .bind(userId, from, to)
      .first<{ s: number }>();
    return row?.s ?? 0;
  }

  async totalForCategory(
    userId: number,
    categoryId: number,
    from: string,
    to: string,
  ): Promise<number> {
    const row = await this.d1
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
          WHERE user_id = ? AND category_id = ? AND spent_on BETWEEN ? AND ?`,
      )
      .bind(userId, categoryId, from, to)
      .first<{ s: number }>();
    return row?.s ?? 0;
  }

  async byCategory(userId: number, from: string, to: string): Promise<CategoryTotal[]> {
    const { results } = await this.d1
      .prepare(
        `SELECT t.category_id AS category_id,
                COALESCE(c.name, 'Uncategorised') AS name,
                COALESCE(c.emoji, '') AS emoji,
                SUM(t.amount) AS total,
                COUNT(*) AS count
           FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
          WHERE t.user_id = ? AND t.spent_on BETWEEN ? AND ?
          GROUP BY t.category_id
          ORDER BY total DESC`,
      )
      .bind(userId, from, to)
      .all<CategoryTotal>();
    return results ?? [];
  }

  async byDay(userId: number, from: string, to: string): Promise<Array<{ day: string; total: number }>> {
    const { results } = await this.d1
      .prepare(
        `SELECT spent_on AS day, SUM(amount) AS total
           FROM transactions
          WHERE user_id = ? AND spent_on BETWEEN ? AND ?
          GROUP BY spent_on ORDER BY spent_on`,
      )
      .bind(userId, from, to)
      .all<{ day: string; total: number }>();
    return results ?? [];
  }

  async byMonth(userId: number, from: string, to: string): Promise<Array<{ period: string; total: number }>> {
    const { results } = await this.d1
      .prepare(
        `SELECT substr(spent_on, 1, 7) AS period, SUM(amount) AS total
           FROM transactions
          WHERE user_id = ? AND spent_on BETWEEN ? AND ?
          GROUP BY period ORDER BY period`,
      )
      .bind(userId, from, to)
      .all<{ period: string; total: number }>();
    return results ?? [];
  }

  async firstTransactionDate(userId: number): Promise<string | null> {
    const row = await this.d1
      .prepare('SELECT MIN(spent_on) AS d FROM transactions WHERE user_id = ?')
      .bind(userId)
      .first<{ d: string | null }>();
    return row?.d ?? null;
  }

  async categoryTrends(user: number, from: string, to: string) {
    return (await this.d1.prepare(`SELECT substr(t.spent_on,1,7) AS period,t.category_id,
      COALESCE(c.name,'Uncategorized') AS name,SUM(t.amount)*100 AS amountMinor
      FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
      WHERE t.user_id=? AND t.spent_on BETWEEN ? AND ? GROUP BY period,t.category_id ORDER BY period`)
      .bind(user,from,to).all<{period:string;category_id:number|null;name:string;amountMinor:number}>()).results;
  }

  async reviewItems(user: number) {
    const [unknown,duplicates,errors,unassignedIncome] = await Promise.all([
      this.d1.prepare(`SELECT id,note AS label,spent_on AS day,amount*100 AS amountMinor FROM transactions
        WHERE user_id=? AND category_id IS NULL ORDER BY spent_on DESC,id DESC LIMIT 101`).bind(user).all<{id:number;label:string;day:string;amountMinor:number}>(),
      this.d1.prepare(`SELECT kind,day,label,amountMinor,COUNT(*) AS count FROM (
        SELECT 'expense' AS kind,spent_on AS day,note AS label,amount*100 AS amountMinor,account_id,0 AS passive FROM transactions WHERE user_id=?
        UNION ALL SELECT 'income',received_on,source,amount_minor,account_id,passive FROM income WHERE user_id=?)
        GROUP BY kind,day,lower(trim(label)),amountMinor,account_id,passive HAVING COUNT(*)>1
        ORDER BY day DESC LIMIT 101`).bind(user,user).all<{day:string;label:string;amountMinor:number;count:number}>(),
      this.finance.errors(user),
      this.d1.prepare(`SELECT id,source AS label,received_on AS day,amount_minor AS amountMinor,
        source_chat,passive FROM income WHERE user_id=? AND account_id IS NULL
        ORDER BY received_on DESC,id DESC LIMIT 101`).bind(user).all<{id:number;label:string;day:string;amountMinor:number;source_chat:number|null;passive:number}>(),
    ]);
    return {unassignedIncome:unassignedIncome.results.slice(0,100).map(r=>({...r,kind:'income' as const,channel:r.source_chat!==null,passive:Boolean(r.passive),accountId:null})),unknown:unknown.results.slice(0,100),duplicates:duplicates.results.slice(0,100),errors,
      truncated:unknown.results.length>100||duplicates.results.length>100||unassignedIncome.results.length>100};
  }

  // ------------------------------------------------------------------ budgets

  async budgets(userId: number): Promise<Budget[]> {
    const { results } = await this.d1
      .prepare('SELECT category_id, amount FROM budgets WHERE user_id = ?')
      .bind(userId)
      .all<Budget>();
    return results ?? [];
  }

  async budget(userId: number, categoryId: number): Promise<number | null> {
    const row = await this.d1
      .prepare('SELECT amount FROM budgets WHERE user_id = ? AND category_id = ?')
      .bind(userId, categoryId)
      .first<{ amount: number }>();
    return row?.amount ?? null;
  }

  async setBudget(userId: number, categoryId: number, amount: number): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO budgets (user_id, category_id, amount, updated_at)
              VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, category_id)
         DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`,
      )
      .bind(userId, categoryId, amount)
      .run();
  }

  async clearBudget(userId: number, categoryId: number): Promise<void> {
    await this.d1
      .prepare('DELETE FROM budgets WHERE user_id = ? AND category_id = ?')
      .bind(userId, categoryId)
      .run();
  }

  // ------------------------------------------------------------------- alerts

  /** Records an alert; returns false when it was already sent this period. */
  async claimAlert(
    userId: number,
    period: string,
    categoryId: number,
    threshold: number,
  ): Promise<boolean> {
    const res = await this.d1
      .prepare(
        `INSERT OR IGNORE INTO alerts (user_id, period, category_id, threshold)
              VALUES (?, ?, ?, ?)`,
      )
      .bind(userId, period, categoryId, threshold)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  // ----------------------------------------------------------------- sessions

  async getState(userId: number): Promise<{ state: string; payload: Record<string, unknown> } | null> {
    const row = await this.d1
      .prepare('SELECT state, payload FROM sessions WHERE user_id = ?')
      .bind(userId)
      .first<{ state: string; payload: string }>();
    if (!row) return null;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    return { state: row.state, payload };
  }

  async setState(
    userId: number,
    state: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO sessions (user_id, state, payload, updated_at)
              VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(user_id)
         DO UPDATE SET state = excluded.state, payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .bind(userId, state, JSON.stringify(payload))
      .run();
  }

  async clearState(userId: number): Promise<void> {
    await this.d1.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}
