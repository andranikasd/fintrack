import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context';
import { OVERALL } from '../db';
import { checkBudgets, paceLine } from '../lib/alerts';
import { monthEnd, monthOf, monthStart, prettyDate, todayIn } from '../lib/dates';
import { categoryKeyboard } from '../lib/keyboards';
import { money } from '../lib/money';
import { matchCategory, parseEntry } from '../lib/parse';
import type { TxWithCategory } from '../types';

export const entry = new Composer<AppContext>();

function txLine(tx: TxWithCategory, sign: string, today: string): string {
  const cat = tx.category_id
    ? `${tx.category_emoji ?? ''} ${tx.category_name ?? ''}`.trim()
    : '❓ no category';
  const when = tx.spent_on === today ? 'today' : prettyDate(tx.spent_on);
  const note = tx.note ? ` · <i>${escapeHtml(tx.note)}</i>` : '';
  return `✅ <b>${money(tx.amount, sign)}</b> · ${escapeHtml(cat)} · ${when}${note}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function afterKeyboard(txId: number, needsCategory: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (needsCategory) kb.text('🗂 Pick category', `pick:${txId}`).row();
  else kb.text('🗂 Change', `pick:${txId}`);
  kb.text('🗑 Delete', `del:${txId}`);
  return kb;
}

/** Confirmation + budget pace, then fire alerts. */
async function confirm(ctx: AppContext, txId: number, needsCategory: boolean): Promise<void> {
  const tx = await ctx.db.transaction(ctx.userId, txId);
  if (!tx) return;
  const today = todayIn(ctx.tz);
  const period = monthOf(tx.spent_on);
  const spent = await ctx.db.totalBetween(ctx.userId, monthStart(period), monthEnd(period));
  const budget = (await ctx.db.budget(ctx.userId, OVERALL)) ?? 0;

  const lines = [txLine(tx, ctx.sign, today)];
  const pace = paceLine(spent, budget, today, ctx.sign);
  if (pace) lines.push(pace);
  else lines.push(`Month so far: <b>${money(spent, ctx.sign)}</b>`);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: afterKeyboard(txId, needsCategory),
  });

  await checkBudgets(
    ctx.db,
    ctx.api,
    ctx.userId,
    ctx.chat!.id,
    tx.spent_on,
    tx.category_id,
    ctx.sign,
  );
}

/** Free-text expense entry. Registered last so commands and states win. */
entry.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  const parsed = parseEntry(text, ctx.tz);
  if (!parsed) {
    await ctx.reply(
      'Send an amount to log it, e.g. <code>1500 cafe latte</code>.\n/help for the full grammar.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const categories = await ctx.db.categories(ctx.userId);
  const { category, note } = matchCategory(parsed.rest, categories);
  const txId = await ctx.db.addTransaction(
    ctx.userId,
    category?.id ?? null,
    parsed.amount,
    note,
    parsed.spentOn,
  );
  await confirm(ctx, txId, category === null);
});

entry.callbackQuery(/^pick:(\d+)$/, async (ctx) => {
  const txId = Number(ctx.match[1]);
  const categories = await ctx.db.categories(ctx.userId);
  if (categories.length === 0) {
    await ctx.answerCallbackQuery({ text: 'No categories yet — /cats', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({
    reply_markup: categoryKeyboard(categories, `setcat:${txId}`),
  });
});

entry.callbackQuery(/^setcat:(\d+):(\d+)$/, async (ctx) => {
  const txId = Number(ctx.match[1]);
  const catId = Number(ctx.match[2]);
  const category = await ctx.db.category(ctx.userId, catId);
  const tx = await ctx.db.transaction(ctx.userId, txId);
  if (!category || !tx) {
    await ctx.answerCallbackQuery({ text: 'Gone already.', show_alert: true });
    return;
  }
  await ctx.db.setTransactionCategory(ctx.userId, txId, catId);
  await ctx.answerCallbackQuery({ text: `${category.emoji} ${category.name}`.trim() });

  const updated = await ctx.db.transaction(ctx.userId, txId);
  if (updated) {
    await ctx.editMessageText(txLine(updated, ctx.sign, todayIn(ctx.tz)), {
      parse_mode: 'HTML',
      reply_markup: afterKeyboard(txId, false),
    });
  }
  await checkBudgets(ctx.db, ctx.api, ctx.userId, ctx.chat!.id, tx.spent_on, catId, ctx.sign);
});

entry.callbackQuery(/^del:(\d+)$/, async (ctx) => {
  const txId = Number(ctx.match[1]);
  const ok = await ctx.db.deleteTransaction(ctx.userId, txId);
  await ctx.answerCallbackQuery({ text: ok ? 'Deleted' : 'Already gone' });
  await ctx.editMessageText('🗑 <s>deleted</s>', { parse_mode: 'HTML' });
});

export async function undoLast(ctx: AppContext): Promise<void> {
  const txId = await ctx.db.lastTransactionId(ctx.userId);
  if (txId === null) {
    await ctx.reply('Nothing to undo.');
    return;
  }
  const tx = await ctx.db.transaction(ctx.userId, txId);
  await ctx.db.deleteTransaction(ctx.userId, txId);
  await ctx.reply(
    tx ? `↩️ Removed ${money(tx.amount, ctx.sign)} · ${prettyDate(tx.spent_on)}` : '↩️ Removed.',
  );
}

entry.command('undo', undoLast);

entry.command('last', async (ctx) => {
  const arg = Number((ctx.match as string).trim());
  const limit = Number.isFinite(arg) && arg > 0 ? Math.min(arg, 20) : 10;
  const rows = await ctx.db.recentTransactions(ctx.userId, limit);
  if (rows.length === 0) {
    await ctx.reply('No expenses yet.');
    return;
  }
  const today = todayIn(ctx.tz);
  const kb = new InlineKeyboard();
  rows.forEach((tx, i) => {
    kb.text(`🗑 ${money(tx.amount, ctx.sign)}`, `del:${tx.id}`);
    if ((i + 1) % 2 === 0) kb.row();
  });
  const body = rows
    .map((tx) => {
      const cat = tx.category_id
        ? `${tx.category_emoji ?? ''} ${tx.category_name ?? ''}`.trim()
        : '❓';
      const when = tx.spent_on === today ? 'today' : prettyDate(tx.spent_on);
      const note = tx.note ? ` · ${escapeHtml(tx.note)}` : '';
      return `<b>${money(tx.amount, ctx.sign)}</b> · ${escapeHtml(cat)} · ${when}${note}`;
    })
    .join('\n');
  await ctx.reply(`<b>Last ${rows.length}</b>\n${body}`, {
    parse_mode: 'HTML',
    reply_markup: kb,
  });
});
