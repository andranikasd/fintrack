import type { Database } from './database';
import { addDays, monthEnd, shiftMonth } from './lib/dates';

export type FlowKind = 'income' | 'expense' | 'saving' | 'withdrawal' | 'transferIn' | 'transferOut' | 'funding';
export interface AccountFlow { accountId:number; day:string; kind:FlowKind; amount:number; passive:number }
export interface AccountBreakdown { accountId:number; period:string; kind:FlowKind; label:string; amount:number }
export interface AccountAnalytics {
  from:string; to:string;
  baseline:{accountId:number;amount:number}[];
  daily:AccountFlow[];
  breakdown:AccountBreakdown[];
  excluded:{period:string;kind:FlowKind;amount:number;count:number}[];
}

/** Aggregate independently of the export's paginated ledger. Opening funds and transfers are not earnings. */
export async function accountAnalytics(sql:Database,user:number,from:string,to:string,today:string):Promise<AccountAnalytics> {
  const anchor=(to>today?today:to).slice(0,7);
  const first=[shiftMonth(anchor,-12),shiftMonth((from>today?today:from).slice(0,7),-1)].sort()[0]!+'-01';
  const last=monthEnd(anchor)<today?monthEnd(anchor):today;
  const movements=`WITH movements AS (
    SELECT account_id AS accountId,received_on AS day,'income' AS kind,amount_minor AS amount,passive,source AS label FROM income WHERE user_id=?1
    UNION ALL SELECT t.account_id,t.spent_on,'expense',t.amount*100,0,COALESCE(c.name,'Uncategorized') FROM transactions t LEFT JOIN categories c ON c.id=t.category_id AND c.user_id=t.user_id WHERE t.user_id=?1
    UNION ALL SELECT s.account_id,s.saved_on,CASE WHEN s.amount_minor>0 THEN 'saving' ELSE 'withdrawal' END,ABS(s.amount_minor),0,g.name FROM savings s JOIN goals g ON g.id=s.goal_id AND g.user_id=s.user_id WHERE s.user_id=?1
    UNION ALL SELECT from_account_id,transferred_on,'transferOut',amount_minor,0,'Transfers' FROM account_transfers WHERE user_id=?1
    UNION ALL SELECT to_account_id,transferred_on,'transferIn',amount_minor,0,'Transfers' FROM account_transfers WHERE user_id=?1
    UNION ALL SELECT id,opening_on,'funding',opening_minor,0,'Opening funds' FROM accounts WHERE user_id=?1
  ), scoped AS (SELECT m.*,CASE WHEN a.id IS NOT NULL AND m.day>=a.opening_on THEN 1 ELSE 0 END AS eligible
    FROM movements m LEFT JOIN accounts a ON a.id=m.accountId AND a.user_id=?1 WHERE m.day BETWEEN ?2 AND ?3)`;
  const [baseline,daily,breakdown,excluded]=await Promise.all([
    sql.prepare(`SELECT a.id AS accountId,COALESCE((SELECT b.balance_minor FROM account_daily_balances b WHERE b.account_id=a.id AND b.user_id=a.user_id AND b.day<=? ORDER BY b.day DESC LIMIT 1),0) AS amount FROM accounts a WHERE a.user_id=?`).bind(addDays(first,-1),user).all<{accountId:number;amount:number}>(),
    sql.prepare(movements+` SELECT accountId,day,kind,passive,SUM(amount) AS amount FROM scoped WHERE eligible=1 GROUP BY accountId,day,kind,passive ORDER BY day`).bind(user,first,last).all<AccountFlow>(),
    sql.prepare(movements+` SELECT accountId,substr(day,1,7) AS period,kind,label,SUM(amount) AS amount FROM scoped WHERE eligible=1 AND kind IN ('income','expense') GROUP BY accountId,period,kind,label`).bind(user,first,last).all<AccountBreakdown>(),
    sql.prepare(movements+` SELECT substr(day,1,7) AS period,kind,SUM(amount) AS amount,COUNT(*) AS count FROM scoped WHERE eligible=0 GROUP BY period,kind`).bind(user,first,last).all<AccountAnalytics['excluded'][number]>(),
  ]);
  return {from:first,to:last,baseline:baseline.results,daily:daily.results,breakdown:breakdown.results,excluded:excluded.results};
}
