import type { Db } from '../db';
import { addDays, daysInMonth, monthEnd, monthStart, shiftMonth } from '../lib/dates';

/** Summary queries are independent of the ledger's date filter and row limit. */
export async function dashboardInsights(db: Db, user: number, today: string, selectedDay: string) {
  const period=selectedDay.slice(0,7), current=period===today.slice(0,7);
  const end=current?today:monthEnd(period), previous=shiftMonth(period,-1);
  const previousEnd=current?`${previous}-${String(Math.min(Number(today.slice(8)),daysInMonth(previous))).padStart(2,'0')}`:monthEnd(previous);
  const totals=async(from:string,to:string)=>{
    const [expense,income,saved]=await Promise.all([db.totalBetween(user,from,to),db.income.total(user,from,to),db.finance.savingsTotal(user,from,to)]);
    return {expense:expense*100,income,saved,savingsRate:income>0?saved/income*100:null};
  };
  const [day,month,lastMonth,budgets,categories,categoryTotals,calendar,trends,review,previousCategories] = await Promise.all([
    totals(today,today),totals(monthStart(period),end),totals(monthStart(previous),previousEnd),db.budgets(user),db.categories(user,true),
    db.byCategory(user,monthStart(period),end),db.byDay(user,monthStart(period),end),
    db.categoryTrends(user,monthStart(shiftMonth(period,-5)),end),db.reviewItems(user),db.byCategory(user,monthStart(previous),previousEnd),
  ]);
  return {today:day,month:{period,from:monthStart(period),to:end,...month,previous:{from:monthStart(previous),to:previousEnd,...lastMonth}},
    calendar,categoryComparison:[...new Set([...categoryTotals,...previousCategories].map(c=>c.category_id))].map(id=>{const now=categoryTotals.find(c=>c.category_id===id),before=previousCategories.find(c=>c.category_id===id);return {id,name:now?.name||before?.name||'Uncategorized',current:(now?.total||0)*100,previous:(before?.total||0)*100,delta:((now?.total||0)-(before?.total||0))*100};}).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)),trendPeriods:Array.from({length:6},(_,i)=>shiftMonth(period,i-5)),trends,
    categoryBudgets:budgets.filter(b=>b.category_id!==0).map(b=>({...b,name:categories.find(c=>c.id===b.category_id)?.name||'Archived category',spent:categoryTotals.find(c=>c.category_id===b.category_id)?.total||0})),review};
}
