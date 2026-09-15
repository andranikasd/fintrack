import { uncategorizedKeyboard } from './category-review';
import { Composer, InputFile } from 'grammy';
import type { AppContext } from '../context';
import type { Db } from '../db';
import { addDays, todayIn } from '../lib/dates';
import { financialStatus } from '../lib/finance';
import { money } from '../lib/money';
import { minorMoney } from '../lib/savings';
import { goalText } from './goals';
import { buildDailyChart } from '../pdf/daily';

export const daily = new Composer<AppContext>();
export async function dailyReport(db: Db,user: number,day: string,today: string,sign: string): Promise<string> {
  const [spent,rows,cats,savings,previous,errors,income] = await Promise.all([
    db.totalBetween(user,day,day),db.transactionsBetween(user,day,day,25),db.byCategory(user,day,day),
    db.finance.savingsByDay(user,day,day),db.totalBetween(user,addDays(day,-1),addDays(day,-1)),db.finance.errors(user),db.income.total(user,day,day),
  ]);
  const lines = [`${day}${day===today?' · so far':''}`,`Income: ${minorMoney(income,sign)}`,`Spent: ${money(spent,sign)}`,
    `Saved: ${minorMoney(savings[0]?.deposits??0,sign)}`,`Withdrawn from savings: ${minorMoney(savings[0]?.withdrawals??0,sign)}`,
    `Net cash flow: ${minorMoney(income-spent*100-(savings[0]?.deposits??0)+(savings[0]?.withdrawals??0),sign)}`,`Previous day spending: ${money(previous,sign)}`,'',...cats.slice(0,12).map(c=>`${c.name}: ${money(c.total,sign)}`),'',
    ...rows.slice(0,15).map(r=>`${r.note||r.category_name||'Expense'} — ${money(r.amount,sign)}`)];
  if (rows.length>15) lines.push('More expenses available in /export.');
  if (day===today) {
    const status = await financialStatus(db,user,today);
    lines.push('',status.budget===null?'Monthly budget not set. /budget 150000':`Monthly spending: ${money(status.spent,sign)} / ${money(status.budget,sign)}`);
    lines.push(`Monthly income: ${minorMoney(status.income,sign)}`);
    if (status.available!==null) lines.push(`Available after reserve${status.prefs.funding==='shared'?' and net savings':''}: ${minorMoney(status.available,sign)}`);
    lines.push(...status.plans.slice(0,3).map(p=>`\n${goalText(p,sign)}`));
  }
  if (errors.length) lines.push('',`⚠ ${errors.length} post(s) need correction. Totals use their last valid version. /syncstatus`);
  return lines.join('\n');
}
for (const command of ['today','yesterday'] as const) daily.command(command,async ctx=> {
  const today = todayIn(ctx.tz);
  const day = command === 'today' ? today : addDays(today, -1);
  const reply_markup = await uncategorizedKeyboard(ctx.db, ctx.userId, day);
  await ctx.reply(await dailyReport(ctx.db,ctx.userId,day,today,ctx.sign), { reply_markup });
});
daily.command('syncstatus',async ctx=> {
  const errors = await ctx.db.finance.errors(ctx.userId);
  await ctx.reply(errors.length?errors.map(e=>`Channel ${e.chat_id}, post #${e.message_id}: ${e.error}`).join('\n'):'All received posts parsed successfully. Only posts received since linking (or edited afterward) are included.');
});
export async function dailySeries(db: Db,user: number,from: string,to: string) {
  const [expenses,savings] = await Promise.all([db.byDay(user,from,to),db.finance.savingsByDay(user,from,to)]);
  const result: Array<{day:string;spent:number;saved:number;withdrawn:number}> = [];
  for (let day=from;day<=to;day=addDays(day,1)) {
    const saving = savings.find(s=>s.day===day);
    result.push({day,spent:expenses.find(s=>s.day===day)?.total??0,saved:(saving?.deposits??0)/100,withdrawn:(saving?.withdrawals??0)/100});
  }
  return result;
}
daily.command('week',async ctx=> {
  const today = todayIn(ctx.tz);
  const series = await dailySeries(ctx.db,ctx.userId,addDays(today,-6),today);
  const max = Math.max(...series.flatMap(s=>[s.spent,s.saved]),1);
  const bar = (n:number)=>'▇'.repeat(n>0?Math.max(1,Math.round(n/max*12)):0);
  await ctx.reply(`Last 7 days · today is incomplete\nSpending / savings deposits\n\n${series.map(s=>`${s.day}\n${bar(s.spent)} ${money(s.spent,ctx.sign)} spent\n${bar(s.saved)} ${minorMoney(Math.round(s.saved*100),ctx.sign)} saved${s.withdrawn?`\nWithdrawn: ${minorMoney(Math.round(s.withdrawn*100),ctx.sign)}`:''}`).join('\n\n')}\n\n/chart 7 for a PDF chart.`);
});
daily.command('compare',async ctx=> {
  const today=todayIn(ctx.tz), end=addDays(today,-1), start=addDays(today,-7), prev=addDays(today,-14);
  const [current,previous,saved,oldSaved] = await Promise.all([ctx.db.totalBetween(ctx.userId,start,end),ctx.db.totalBetween(ctx.userId,prev,addDays(start,-1)),ctx.db.finance.savingsTotal(ctx.userId,start,end),ctx.db.finance.savingsTotal(ctx.userId,prev,addDays(start,-1))]);
  await ctx.reply(`Seven completed days (${start} to ${end}) vs preceding seven\nSpent: ${money(current,ctx.sign)} vs ${money(previous,ctx.sign)}\nChange: ${money(current-previous,ctx.sign)}${previous?` (${Math.round((current-previous)/previous*100)}%)`:''}\nNet savings: ${minorMoney(saved,ctx.sign)} vs ${minorMoney(oldSaved,ctx.sign)}\nToday is excluded for a fair comparison.`);
});
daily.command('chart',async ctx=> {
  const arg=ctx.match.trim()||'30';
  if (!/^\d+$/.test(arg)||Number(arg)<1||Number(arg)>90) {await ctx.reply('Use /chart 7, /chart 30, or any range from 1 to 90 days.');return;}
  const to=todayIn(ctx.tz),from=addDays(to,1-Number(arg));
  await ctx.reply('Building your spending and savings chart…');
  ctx.exec.waitUntil((async()=> {
    const series=await dailySeries(ctx.db,ctx.userId,from,to);
    const bytes=await buildDailyChart(series,to);
    await ctx.api.sendDocument(ctx.chat!.id,new InputFile(bytes,`fintrack-daily-${from}-${to}.pdf`),{caption:'Daily spending and confirmed savings. Today is incomplete; missing days mean no entries recorded.'});
  })().catch(async err=>{console.error('daily chart failed',err);await ctx.api.sendMessage(ctx.chat!.id,'Could not build the chart. Try again.');}));
});
