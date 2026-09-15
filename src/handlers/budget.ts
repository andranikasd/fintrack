import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context';
import { OVERALL } from '../db';
import { progressBar } from '../lib/alerts';
import { monthEnd, monthLabel, monthOf, monthStart, todayIn } from '../lib/dates';
import { financialStatus } from '../lib/finance';
import { minorMoney } from '../lib/savings';
import { money, parseAmount, pct } from '../lib/money';
import { escapeHtml } from './entry';

export const budget = new Composer<AppContext>();

export async function renderBudgets(ctx: AppContext, edit = false): Promise<void> {
  const period = monthOf(todayIn(ctx.tz));
  const from = monthStart(period);
  const to = monthEnd(period);

  const [rows, cats, spentTotal, byCat] = await Promise.all([
    ctx.db.budgets(ctx.userId),
    ctx.db.categories(ctx.userId),
    ctx.db.totalBetween(ctx.userId, from, to),
    ctx.db.byCategory(ctx.userId, from, to),
  ]);
  const budgetBy = new Map(rows.map((r) => [r.category_id, r.amount]));
  const spentBy = new Map(byCat.map((r) => [r.category_id, r.total]));

  const overall = budgetBy.get(OVERALL) ?? 0;
  const lines = [`<b>Budgets</b> · ${monthLabel(period)}`, ''];

  if (overall > 0) {
    lines.push(
      `<b>Monthly limit ${money(overall, ctx.sign)}</b>`,
      `${progressBar(spentTotal, overall)} ${pct(spentTotal, overall)}% · spent ${money(spentTotal, ctx.sign)}`,
      spentTotal <= overall
        ? `Unspent before savings/reserve: ${money(overall - spentTotal, ctx.sign)}`
        : `Over by ${money(spentTotal - overall, ctx.sign)}`,
    );
  } else {
    lines.push('No monthly limit set.');
  }

  const perCategory = cats
    .filter((c) => (budgetBy.get(c.id) ?? 0) > 0)
    .map((c) => {
      const limit = budgetBy.get(c.id)!;
      const spent = spentBy.get(c.id) ?? 0;
      return `${c.emoji} ${escapeHtml(c.name)} — ${money(spent, ctx.sign)} / ${money(limit, ctx.sign)} (${pct(spent, limit)}%)`;
    });
  if (perCategory.length) lines.push('', '<b>Per category</b>', ...perCategory);

  const status = await financialStatus(ctx.db,ctx.userId,todayIn(ctx.tz));
  if (status.available !== null) lines.push(`Available after reserve${status.prefs.funding === 'shared' ? ' and net savings' : ''}: ${minorMoney(status.available,ctx.sign)}`);
  lines.push(`Savings funding: ${status.prefs.funding}. /funding to change.`);

  lines.push('', 'Alerts fire at 80%, 100%, 120%, 150% and 200%.');

  const kb = new InlineKeyboard()
    .text(overall > 0 ? '✏️ Monthly limit' : '🎯 Set monthly limit', 'bud:set:0')
    .row()
    .text('🗂 Category limit', 'bud:pick');
  if (overall > 0) kb.row().text('🚫 Clear monthly limit', 'bud:clear:0');

  const text = lines.join('\n');
  if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

budget.command('budget', async (ctx) => {
  const arg = (ctx.match as string).trim();
  if (arg) {
    const amount = parseAmount(arg);
    if (amount === null) {
      await ctx.reply('Send a number, e.g. <code>/budget 400k</code>.', { parse_mode: 'HTML' });
      return;
    }
    await ctx.db.setBudget(ctx.userId, OVERALL, amount);
    await ctx.reply(`Monthly limit set to <b>${money(amount, ctx.sign)}</b>.`, {
      parse_mode: 'HTML',
    });
  }
  await renderBudgets(ctx);
});

budget.callbackQuery('bud:list', async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderBudgets(ctx, true);
});

budget.callbackQuery('bud:pick', async (ctx) => {
  const cats = await ctx.db.categories(ctx.userId);
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard();
  cats.forEach((c, i) => {
    kb.text(`${c.emoji} ${c.name}`.trim(), `bud:cat:${c.id}`);
    if ((i + 1) % 3 === 0) kb.row();
  });
  kb.row().text('⬅️ Back', 'bud:list');
  await ctx.editMessageText('Which category gets a limit?', { reply_markup: kb });
});

budget.callbackQuery(/^bud:cat:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const category = await ctx.db.category(ctx.userId, id);
  if (!category) {
    await ctx.answerCallbackQuery({ text: 'Gone.', show_alert: true });
    return;
  }
  const current = await ctx.db.budget(ctx.userId, id);
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard().text('✏️ Set limit', `bud:set:${id}`);
  if (current) kb.text('🚫 Clear', `bud:clear:${id}`);
  kb.row().text('⬅️ Back', 'bud:list');
  await ctx.editMessageText(
    `<b>${category.emoji} ${escapeHtml(category.name)}</b>\n` +
      (current ? `Limit: ${money(current, ctx.sign)}` : 'No limit set.'),
    { parse_mode: 'HTML', reply_markup: kb },
  );
});

budget.callbackQuery(/^bud:set:(\d+)$/, async (ctx) => {
  const categoryId = Number(ctx.match[1]);
  const label =
    categoryId === OVERALL
      ? 'the whole month'
      : (await ctx.db.category(ctx.userId, categoryId))?.name ?? 'that category';
  await ctx.answerCallbackQuery();
  await ctx.db.setState(ctx.userId, 'budget_set', { categoryId });
  await ctx.reply(
    `Send the limit for <b>${escapeHtml(label)}</b>, e.g. <code>400k</code> or <code>400,000</code>.\n\n/cancel to stop.`,
    { parse_mode: 'HTML' },
  );
});

budget.callbackQuery(/^bud:clear:(\d+)$/, async (ctx) => {
  const categoryId = Number(ctx.match[1]);
  await ctx.db.clearBudget(ctx.userId, categoryId);
  await ctx.answerCallbackQuery({ text: 'Limit cleared' });
  await renderBudgets(ctx, true);
});

/** Called from the state router when the user sends a budget amount. */
export async function handleBudgetAmount(
  ctx: AppContext,
  categoryId: number,
  raw: string,
): Promise<void> {
  const amount = parseAmount(raw.trim());
  if (amount === null) {
    await ctx.reply('That is not a number. Try <code>400k</code> or /cancel.', {
      parse_mode: 'HTML',
    });
    return;
  }
  await ctx.db.setBudget(ctx.userId, categoryId, amount);
  await ctx.db.clearState(ctx.userId);
  const label =
    categoryId === OVERALL
      ? 'Monthly limit'
      : `${(await ctx.db.category(ctx.userId, categoryId))?.name ?? 'Category'} limit`;
  await ctx.reply(`${escapeHtml(label)} set to <b>${money(amount, ctx.sign)}</b>.`, {
    parse_mode: 'HTML',
  });
  await renderBudgets(ctx);
}
