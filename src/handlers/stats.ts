import { richDailyReport, reportTable } from '../lib/rich-report';
import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context';
import { OVERALL, type Db } from '../db';
import { progressBar } from '../lib/alerts';
import {
  dayOfMonth,
  daysInMonth,
  monthEnd,
  monthLabel,
  monthOf,
  monthStart,
  shiftMonth,
  todayIn,
} from '../lib/dates';
import { minorMoney } from '../lib/savings';
import { money, pct } from '../lib/money';
import { escapeHtml } from './entry';

export const stats = new Composer<AppContext>();

const BAR = '▇';

export async function monthReport(
  db: Db,
  userId: number,
  period: string,
  tz: string,
  sign: string,
): Promise<string> {
  const from = monthStart(period);
  const to = monthEnd(period);
  const [total, cats, limit] = await Promise.all([
    db.totalBetween(userId, from, to),
    db.byCategory(userId, from, to),
    db.budget(userId, OVERALL),
  ]);

  const today = todayIn(tz);
  const isCurrent = monthOf(today) === period;
  const days = daysInMonth(period);
  const elapsed = isCurrent ? dayOfMonth(today) : days;
  const perDay = elapsed > 0 ? Math.round(total / elapsed) : 0;

  const lines = [`<b>${monthLabel(period)}</b>`, `Spent: <b>${money(total, sign)}</b>`];

  if (limit && limit > 0) {
    lines.push(`${progressBar(total, limit)} ${pct(total, limit)}% of ${money(limit, sign)}`);
    lines.push(
      total <= limit
        ? `Unspent before savings/reserve: <b>${money(limit - total, sign)}</b>`
        : `Over by: <b>${money(total - limit, sign)}</b>`,
    );
  }

  const prefs = await db.finance.preferences(userId);
  const netSavings = await db.finance.savingsTotal(userId,from,to);
  const received = await db.income.total(userId,from,to);
  lines.push(`Income: ${minorMoney(received,sign)}`,`Net cash flow after savings: ${minorMoney(received-total*100-netSavings,sign)}`);
  lines.push(`Confirmed net savings: ${minorMoney(netSavings,sign)}`);
  if (limit) lines.push(`Available after reserve${prefs.funding === 'shared' ? ' and net savings' : ''}: ${minorMoney(limit*100-total*100-prefs.reserve_minor-(prefs.funding === 'shared'?netSavings:0),sign)}`);

  if (total === 0) {
    lines.push('', 'No expenses in this month.');
    return lines.join('\n');
  }

  lines.push(`Average: ${money(perDay, sign)}/day over ${elapsed} day(s)`);
  if (isCurrent && elapsed < days) {
    lines.push(`Projected month: ${money(perDay * days, sign)}`);
  }

  lines.push('', '<b>By category</b>');
  const top = cats.slice(0, 12);
  const max = top[0]?.total ?? 1;
  for (const c of top) {
    const width = Math.max(1, Math.round((c.total / max) * 10));
    const name = `${c.emoji} ${c.name}`.trim();
    lines.push(
      `<code>${BAR.repeat(width).padEnd(10)}</code> ${escapeHtml(name)} — ${money(c.total, sign)} (${pct(c.total, total)}%)`,
    );
  }
  if (cats.length > top.length) lines.push(`…and ${cats.length - top.length} more`);

  return lines.join('\n');
}

export function richMonthReport(text: string) {
  const plain=text.replace(/<code>[^<]*<\/code>\s*/g,'').replace(/<[^>]+>/g,'')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  return richDailyReport(plain);
}

function monthKeyboard(period: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('◀️', `month:${shiftMonth(period, -1)}`)
    .text('📄 PDF', `export:pdf:${period}`)
    .text('▶️', `month:${shiftMonth(period, 1)}`);
}

export async function sendMonth(ctx: AppContext): Promise<void> {
  const period = monthOf(todayIn(ctx.tz));
  const text = await monthReport(ctx.db, ctx.userId, period, ctx.tz, ctx.sign);
  await ctx.api.sendRichMessage(ctx.chat!.id,richMonthReport(text), { reply_markup: monthKeyboard(period) });
}

stats.command('month', sendMonth);

stats.callbackQuery(/^month:(\d{4}-\d{2})$/, async (ctx) => {
  const period = ctx.match[1]!;
  await ctx.answerCallbackQuery();
  const text = await monthReport(ctx.db, ctx.userId, period, ctx.tz, ctx.sign);
  await ctx.editMessageText(richMonthReport(text), { reply_markup: monthKeyboard(period) });
});

export async function sendStats(ctx: AppContext): Promise<void> {
  const today = todayIn(ctx.tz);
  const current = monthOf(today);
  const first = shiftMonth(current, -5);
  const months = await ctx.db.byMonth(ctx.userId, monthStart(first), monthEnd(current));
  if (months.length === 0) {
    await ctx.reply('No data yet. Log something like <code>1500 cafe</code>.', {
      parse_mode: 'HTML',
    });
    return;
  }
  const byPeriod = new Map(months.map((m) => [m.period, m.total]));
  const series: Array<{ period: string; total: number }> = [];
  for (let i = 5; i >= 0; i--) {
    const p = shiftMonth(current, -i);
    series.push({ period: p, total: byPeriod.get(p) ?? 0 });
  }
  const sum=series.reduce((total,s)=>total+s.total,0);
  const activeMonths=series.filter(s=>s.total>0).length||1;
  const top=await ctx.db.byCategory(ctx.userId,monthStart(first),monthEnd(current));
  await ctx.api.sendRichMessage(ctx.chat!.id,{blocks:[
    {type:'heading',size:2,text:'Last 6 months'},
    reportTable(['Month','Spending'],series.map(s=>[monthLabel(s.period),money(s.total,ctx.sign)])),
    {type:'paragraph',text:{type:'bold',text:`Average recorded month: ${money(Math.round(sum/activeMonths),ctx.sign)}`}},
    {type:'heading',size:3,text:'Top categories'},
    reportTable(['Category','Spending'],top.slice(0,5).map(c=>[c.name,money(c.total,ctx.sign)])),
    {type:'footer',text:'The current month is incomplete. Months without recorded spending are excluded from the average.'},
  ]},{reply_markup:new InlineKeyboard().text('📄 PDF, 6 months',`export:pdf6:${current}`)});

}

stats.command('stats', sendStats);
