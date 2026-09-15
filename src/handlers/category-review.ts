import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context';
import type { Db } from '../db';
import { categoryKeyboard } from '../lib/keyboards';
import { validDate } from '../lib/savings';
import { splitEmoji } from './categories';

export const categoryReview = new Composer<AppContext>();
const PAGE_SIZE = 10;

export async function uncategorizedKeyboard(db: Db, userId: number, day: string | null, offset = 0): Promise<InlineKeyboard | undefined> {
  const rows = await db.uncategorized(userId, day, offset, PAGE_SIZE + 1);
  if (!rows.length && offset === 0) return undefined;
  const keyboard = new InlineKeyboard();
  for (const row of rows.slice(0, PAGE_SIZE)) {
    keyboard.text(`Categorize ${row.label || `expense #${row.id}`}`.slice(0, 60), `review:pick:${row.id}`).row();
  }
  const scope = day ?? 'all';
  if (offset > 0) keyboard.text('◀ Previous', `review:page:${scope}:${Math.max(0, offset - PAGE_SIZE)}`);
  if (rows.length > PAGE_SIZE) keyboard.text('More items ▶', `review:page:${scope}:${offset + PAGE_SIZE}`);
  return keyboard;
}

async function sendItems(ctx: AppContext, day: string | null, offset = 0): Promise<void> {
  const keyboard = await uncategorizedKeyboard(ctx.db, ctx.userId, day, offset);
  await ctx.reply(keyboard ? 'Choose an item to categorize. I’ll remember matching channel items.' : 'No uncategorized items left.', {
    reply_markup: keyboard,
  });
}

categoryReview.command('uncategorized', async ctx => {
  const arg = ctx.match.trim();
  if (arg && !validDate(arg)) { await ctx.reply('Use /uncategorized or /uncategorized 2026-09-15.'); return; }
  await sendItems(ctx, arg || null);
});

categoryReview.callbackQuery(/^review:page:(all|\d{4}-\d{2}-\d{2}):(\d+)$/, async ctx => {
  await ctx.answerCallbackQuery();
  const day = ctx.match[1] === 'all' ? null : ctx.match[1]!;
  if (day && !validDate(day)) return;
  await sendItems(ctx, day, Math.min(Number(ctx.match[2]), 1_000_000));
});

categoryReview.callbackQuery(/^review:pick:(\d+)$/, async ctx => {
  const tx = await ctx.db.transaction(ctx.userId, Number(ctx.match[1]));
  if (!tx || tx.category_id !== null) {
    await ctx.answerCallbackQuery({ text: 'This item changed or is already categorized. Refresh the report.', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  const keyboard = categoryKeyboard(await ctx.db.categories(ctx.userId), `review:set:${tx.id}`);
  keyboard.row().text('➕ New category', `review:new:${tx.id}`);
  await ctx.reply(`Which category fits “${tx.note || `expense #${tx.id}`}”?`, { reply_markup: keyboard });
});

async function assign(ctx: AppContext, txId: number, categoryId: number): Promise<string | null> {
  const [tx, category] = await Promise.all([
    ctx.db.transaction(ctx.userId, txId), ctx.db.category(ctx.userId, categoryId),
  ]);
  if (!tx || tx.category_id !== null || !category || category.archived) return null;
  await ctx.db.setTransactionCategory(ctx.userId, txId, categoryId);
  if (tx.source_chat != null) await ctx.db.finance.alias(ctx.userId, tx.note, categoryId);
  return `${tx.note || `Expense #${tx.id}`} → ${category.name}.` +
    (tx.source_chat != null ? '\nMatching channel entries are updated, and future ones will use this category.' : '') +
    '\nRun /today again to refresh the report.';
}

const moreKeyboard = () => new InlineKeyboard().text('Review more items', 'review:page:all:0');

categoryReview.callbackQuery(/^review:set:(\d+):(\d+)$/, async ctx => {
  const text = await assign(ctx, Number(ctx.match[1]), Number(ctx.match[2]));
  if (!text) {
    await ctx.answerCallbackQuery({ text: 'The item or category changed. Refresh the report and choose again.', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery({ text: 'Category saved' });
  await ctx.editMessageText(text, { reply_markup: moreKeyboard() });
});

categoryReview.callbackQuery(/^review:new:(\d+)$/, async ctx => {
  const txId = Number(ctx.match[1]);
  const tx = await ctx.db.transaction(ctx.userId, txId);
  if (!tx || tx.category_id !== null) {
    await ctx.answerCallbackQuery({ text: 'This item changed. Refresh the report.', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.db.setState(ctx.userId, 'review_new_category', { txId });
  await ctx.reply(`Send the category name for “${tx.note || `expense #${tx.id}`}”, optionally with an emoji. /cancel to stop.`);
});

export async function handleReviewCategoryName(ctx: AppContext, txId: number, raw: string): Promise<void> {
  const tx = await ctx.db.transaction(ctx.userId, txId);
  if (!tx || tx.category_id !== null) {
    await ctx.db.clearState(ctx.userId);
    await ctx.reply('That item changed. Run /uncategorized to choose again.');
    return;
  }
  const { name, emoji } = splitEmoji(raw);
  if (!name) { await ctx.reply('Send a category name or /cancel.'); return; }
  const created = await ctx.db.addCategory(ctx.userId, name, emoji);
  const category = created ?? (await ctx.db.categories(ctx.userId, true)).find(c => c.name.toLowerCase() === name.toLowerCase());
  if (!category || category.archived) {
    await ctx.reply('That category is archived. Unarchive it with /cats, or send a different name.');
    return;
  }
  const text = await assign(ctx, txId, category.id);
  await ctx.db.clearState(ctx.userId);
  await ctx.reply(text ?? 'That item changed. Run /uncategorized to choose again.', { reply_markup: moreKeyboard() });
}
