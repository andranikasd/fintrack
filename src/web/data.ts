import { dashboardInsights } from './insights';
import type { Db } from '../db';
import { financialStatus } from '../lib/finance';
import { todayIn } from '../lib/dates';
import { validDate } from '../lib/savings';

export interface DashboardRecord {
  id: number; kind: 'expense' | 'income' | 'saving' | 'withdrawal'; day: string;
  label: string; amountMinor: number; categoryId: number | null; category: string;
  channel: boolean; entryKey?:string; originalLabel?: string; accountId?:number|null; passive?:boolean;
}
export function validateRange(from: string, to: string): void {
  if (!validDate(from) || !validDate(to) || from > to || Date.parse(to)-Date.parse(from)>365*86400000) {
    throw new Error('Choose a valid date range of up to 366 days.');
  }
}
export async function dashboardData(db: Db, user: number, tz: string, from: string, to: string) {
  validateRange(from,to);
  const today = todayIn(tz);
  const [expenses,incomes,savings,categories,status,warnings,insights,accounts,workspace] = await Promise.all([
    db.transactionsBetween(user,from,to,10001),db.income.list(user,from,to),db.finance.savingsEntries(user,from,to),
    db.categories(user,true),financialStatus(db,user,today),db.finance.errors(user),dashboardInsights(db,user,today,to>today?today:to),db.accounts.list(user,today),db.workspace.data(db,user,from,to,today),
  ]);
  if (expenses.length+incomes.length+savings.length>10000) throw new Error('More than 10,000 records. Choose a shorter date range.');
  const records: DashboardRecord[] = [
    ...expenses.map(r=>({id:r.id,kind:'expense' as const,entryKey:r.source_chat==null?`expense:${r.id}`:`channel:${r.source_chat}:${r.source_message}:expense:${r.note.trim().toLowerCase()}`,accountId:r.account_id??null,day:r.spent_on,label:r.note||r.category_name||'Expense',originalLabel:r.note,amountMinor:r.amount*100,categoryId:r.category_id,category:r.category_name||'Uncategorized',channel:r.source_chat!=null})),
    ...incomes.map(r=>({id:r.id,kind:'income' as const,entryKey:r.source_chat==null?`income:${r.id}`:`channel:${r.source_chat}:${r.source_message}:income:${r.source.trim().toLowerCase()}`,accountId:r.account_id,passive:Boolean(r.passive),day:r.received_on,label:r.source,amountMinor:r.amount_minor,categoryId:null,category:r.source,channel:r.source_chat!==null})),
    ...savings.map(r=>({id:r.id,kind:r.amount_minor>0?'saving' as const:'withdrawal' as const,day:r.saved_on,label:r.goal_name,amountMinor:Math.abs(r.amount_minor),categoryId:null,category:r.goal_name,channel:r.source_chat!==null})),
  ].sort((a,b)=>b.day.localeCompare(a.day)||b.id-a.id);
  return {from,to,today,insights,accounts,workspace,records,categories,status,warnings: warnings.map(w=>`Channel post #${w.message_id}: ${w.error}`)};
}
export type DashboardData = Awaited<ReturnType<typeof dashboardData>>;
