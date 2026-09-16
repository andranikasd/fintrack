import { sendDashboard } from './dashboard';
import { Composer, InlineKeyboard, InputFile } from 'grammy';
import type { AppContext } from '../context';
import { OVERALL, type Db } from '../db';
import {
  addDays,
  monthEnd,
  monthLabel,
  monthOf,
  monthStart,
  prettyDate,
  shiftMonth,
  todayIn,
} from '../lib/dates';
import { buildReport, type ReportData } from '../pdf/report';

export const exportData = new Composer<AppContext>();

const MENU = (period: string): InlineKeyboard =>
  new InlineKeyboard()
    .text('Interactive HTML report','export:html').row()
    .text('Monthly summary','reports:month').text('Spending trends','reports:stats').row()
    .text('📄 This month', `export:pdf:${period}`)
    .text('📄 Last month', `export:pdf:${shiftMonth(period, -1)}`)
    .row()
    .text('📄 Last 6 months', `export:pdf6:${period}`)
    .row()
    .text('🧾 CSV, this month', `export:csv:${period}`)
    .text('🧾 CSV, everything', 'export:csvall');

export async function sendExportMenu(ctx: AppContext): Promise<void> {
  const period = monthOf(todayIn(ctx.tz));
  await ctx.reply('Choose a report. HTML lets you explore and filter; PDF is ready to share; CSV contains expense rows.', { reply_markup: MENU(period) });
}

exportData.command('export', sendExportMenu);
exportData.callbackQuery('export:html',async ctx=>{await ctx.answerCallbackQuery({text:'Building your report…'});await sendDashboard(ctx);});

exportData.callbackQuery(/^export:pdf:(\d{4}-\d{2})$/, async (ctx) => {
  const period = ctx.match[1]!;
  await ctx.answerCallbackQuery({ text: 'Building the PDF…' });
  schedule(ctx, () => sendPdf(ctx, monthStart(period), monthEnd(period), monthLabel(period), period));
});

exportData.callbackQuery(/^export:pdf6:(\d{4}-\d{2})$/, async (ctx) => {
  const period = ctx.match[1]!;
  const first = shiftMonth(period, -5);
  await ctx.answerCallbackQuery({ text: 'Building the PDF…' });
  schedule(ctx, () =>
    sendPdf(
      ctx,
      monthStart(first),
      monthEnd(period),
      `${monthLabel(first)} — ${monthLabel(period)}`,
      null,
    ),
  );
});

exportData.callbackQuery(/^export:csv:(\d{4}-\d{2})$/, async (ctx) => {
  const period = ctx.match[1]!;
  await ctx.answerCallbackQuery();
  await sendCsv(ctx, monthStart(period), monthEnd(period), `fintrack-${period}.csv`);
});

exportData.callbackQuery('export:csvall', async (ctx) => {
  await ctx.answerCallbackQuery();
  const first = (await ctx.db.firstTransactionDate(ctx.userId)) ?? todayIn(ctx.tz);
  await sendCsv(ctx, first, todayIn(ctx.tz), 'fintrack-all.csv');
});

/** Runs heavy work after the webhook response so Telegram does not retry. */
function schedule(ctx: AppContext, work: () => Promise<void>): void {
  const guarded = work().catch(async (err: unknown) => {
    console.error('export failed', err);
    await ctx.api
      .sendMessage(ctx.chat!.id, '❌ Could not build that report. Try a shorter period.')
      .catch(() => undefined);
  });
  if (ctx.exec) ctx.exec.waitUntil(guarded);
}

export async function collectReport(
  db: Db,
  userId: number,
  from: string,
  to: string,
  label: string,
  singleMonth: string | null,
  currency: string,
  today: string,
): Promise<ReportData> {
  to = to > today ? today : to;
  if (from > to) throw new Error('The report period has not started yet.');
  const trendFrom = monthStart(shiftMonth(monthOf(to), -5));
  const [total, byCategory, byDay, byMonth, transactions, budgets, incomes, savings, accounts, openingAccounts, goals, transfers] = await Promise.all([
    db.totalBetween(userId, from, to),
    db.byCategory(userId, from, to),
    db.byDay(userId, from, to),
    db.byMonth(userId, trendFrom < from ? trendFrom : from, to),
    db.transactionsBetween(userId, from, to, 10001),
    db.budgets(userId),
    db.income.list(userId,from,to),db.finance.savingsEntries(userId,from,to),
    db.accounts.list(userId,to),db.accounts.list(userId,addDays(from,-1)),db.finance.goals(userId),
    db.transfers.list(userId,from,to),
  ]);

  if (transactions.length + incomes.length + savings.length + transfers.length > 10000) throw new Error('More than 10,000 records. Choose a shorter report period.');
  const categoryBudgets = new Map<number, number>();
  let budgetOverall = 0;
  // A partial-month range cannot be compared with a whole-month spending limit.
  for (const b of (singleMonth && from === monthStart(singleMonth) ? budgets : [])) {
    if (b.category_id === OVERALL) budgetOverall = b.amount;
    else categoryBudgets.set(b.category_id, b.amount);
  }

  return {
    periodLabel: label,
    from,
    to,
    total,
    byCategory,
    byDay,
    byMonth,
    budgetOverall,
    categoryBudgets,
    transactions,
    currency,
    generatedOn: today,
    singleMonth,
    finance: { incomes, savings, accounts, openingAccounts, goals, transfers },
  };
}

async function sendPdf(
  ctx: AppContext,
  from: string,
  to: string,
  label: string,
  singleMonth: string | null,
): Promise<void> {
  const data = await collectReport(
    ctx.db,
    ctx.userId,
    from,
    to,
    label,
    singleMonth,
    ctx.env.CURRENCY,
    todayIn(ctx.tz),
  );
  if (data.transactions.length === 0 && !data.finance?.incomes.length && !data.finance?.savings.length && !data.finance?.accounts.length) {
    await ctx.api.sendMessage(ctx.chat!.id, `Nothing recorded in ${label}.`);
    return;
  }
  const bytes = await buildReport(data);
  const name = `fintrack-${singleMonth ?? `${from}_${to}`}.pdf`;
  await ctx.api.sendDocument(ctx.chat!.id, new InputFile(bytes, name), {
    caption: `${label} · Accounts, cash flow, budgets, savings and full transaction details`,
  });
}

async function sendCsv(
  ctx: AppContext,
  from: string,
  to: string,
  filename: string,
): Promise<void> {
  const rows = await ctx.db.transactionsBetween(ctx.userId, from, to);
  if (rows.length === 0) {
    await ctx.reply('Nothing to export for that period.');
    return;
  }
  const header = 'date,category,note,amount,currency\n';
  const body = rows
    .map((tx) =>
      [
        tx.spent_on,
        csvCell(tx.category_name ?? 'Uncategorised'),
        csvCell(tx.note),
        String(tx.amount),
        ctx.env.CURRENCY,
      ].join(','),
    )
    .join('\n');
  const bytes = new TextEncoder().encode(`﻿${header}${body}\n`);
  await ctx.api.sendDocument(ctx.chat!.id, new InputFile(bytes, filename), {
    caption: `${rows.length} expenses · ${prettyDate(from)} — ${prettyDate(to)}`,
  });
}

function csvCell(value: string): string {
  const clean = value.replace(/\r?\n/g, ' ');
  return /[",]/.test(clean) ? `"${clean.replace(/"/g, '""')}"` : clean;
}
