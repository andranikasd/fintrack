import { Composer, InlineKeyboard, InputFile } from 'grammy';
import type { AppContext } from '../context';
import { OVERALL, type Db } from '../db';
import {
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
    .text('📄 This month', `export:pdf:${period}`)
    .text('📄 Last month', `export:pdf:${shiftMonth(period, -1)}`)
    .row()
    .text('📄 Last 6 months', `export:pdf6:${period}`)
    .row()
    .text('🧾 CSV, this month', `export:csv:${period}`)
    .text('🧾 CSV, everything', 'export:csvall');

export async function sendExportMenu(ctx: AppContext): Promise<void> {
  const period = monthOf(todayIn(ctx.tz));
  await ctx.reply('What should I build?', { reply_markup: MENU(period) });
}

exportData.command('export', sendExportMenu);

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
  const trendFrom = monthStart(shiftMonth(monthOf(to), -5));
  const [total, byCategory, byDay, byMonth, transactions, budgets] = await Promise.all([
    db.totalBetween(userId, from, to),
    db.byCategory(userId, from, to),
    db.byDay(userId, from, to),
    db.byMonth(userId, trendFrom < from ? trendFrom : from, to),
    db.transactionsBetween(userId, from, to),
    db.budgets(userId),
  ]);

  const categoryBudgets = new Map<number, number>();
  let budgetOverall = 0;
  for (const b of budgets) {
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
  if (data.transactions.length === 0) {
    await ctx.api.sendMessage(ctx.chat!.id, `Nothing recorded in ${label}.`);
    return;
  }
  const bytes = await buildReport(data);
  const name = `fintrack-${singleMonth ?? `${from}_${to}`}.pdf`;
  await ctx.api.sendDocument(ctx.chat!.id, new InputFile(bytes, name), {
    caption: `${label} · ${data.transactions.length} expenses`,
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
