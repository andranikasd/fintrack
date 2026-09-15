import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context';
import { monthOf, monthStart, monthEnd, todayIn } from '../lib/dates';
import { minorMoney, parseMinor, validDate } from '../lib/savings';

export const income = new Composer<AppContext>();
income.command('income', async ctx => {
  const arg = ctx.match.trim();
  const today = todayIn(ctx.tz);
  if (arg) {
    const match = /^(.+?)\s+([\d,.]+[km]?)(?:\s+(\d{4}-\d{2}-\d{2}))?$/i.exec(arg);
    const amount = match ? parseMinor(match[2]!) : null;
    const day = match?.[3] ?? today;
    if (!match || !match[1]!.trim() || match[1]!.length > 120 || amount === null || !validDate(day) || day > today) {
      await ctx.reply('Use /income salary 450000 or /income freelance 25000.50 2026-09-15. Only record money received.\nIn a channel table, use income:salary | 450000.');
      return;
    }
    const added = await ctx.db.income.add(ctx.userId,match[1]!.trim(),amount,day,`message:${ctx.chat.id}:${ctx.message!.message_id}`);
    await ctx.reply(added ? `Income recorded: ${minorMoney(amount,ctx.sign)} from ${match[1]} on ${day}.` : 'This income was already recorded.');
  }
  const from = monthStart(monthOf(today)), to = monthEnd(monthOf(today));
  const [total, sources, rows] = await Promise.all([
    ctx.db.income.total(ctx.userId,from,to), ctx.db.income.bySource(ctx.userId,from,to), ctx.db.income.list(ctx.userId,from,to,10),
  ]);
  const keyboard = new InlineKeyboard();
  for (const row of rows.filter(r=>r.source_chat===null)) keyboard.text(`Remove ${row.source.slice(0,30)} ${minorMoney(row.amount_minor,ctx.sign)}`,`income:remove:${row.id}`).row();
  await ctx.reply(`Income · ${monthOf(today)}\nReceived: ${minorMoney(total,ctx.sign)}\n\n${sources.slice(0,15).map(r=>`${r.source}: ${minorMoney(r.total,ctx.sign)}`).join('\n') || 'No income recorded. /income salary 450000'}\n\nIncome does not change your chosen spending budget.`, {reply_markup:keyboard});
});
income.callbackQuery(/^income:remove:(\d+)$/, async ctx => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Remove this income entry?', {reply_markup:new InlineKeyboard().text('Remove income',`income:confirm:${ctx.match[1]}`).text('Keep it','income:keep')});
});
income.callbackQuery('income:keep', async ctx => { await ctx.answerCallbackQuery(); await ctx.editMessageText('Income kept. /income to view it.'); });
income.callbackQuery(/^income:confirm:(\d+)$/, async ctx => {
  const removed = await ctx.db.income.remove(ctx.userId,Number(ctx.match[1]));
  await ctx.answerCallbackQuery({text:removed?'Income removed':'Already removed, or edit the source channel table.'});
  if (removed) await ctx.editMessageText('Income removed. /income to view the updated total.');
});
