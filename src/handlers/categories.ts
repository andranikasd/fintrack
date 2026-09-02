import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context';
import { monthEnd, monthOf, monthStart, todayIn } from '../lib/dates';
import { money } from '../lib/money';
import { escapeHtml } from './entry';

export const categories = new Composer<AppContext>();

export async function renderList(ctx: AppContext, edit = false): Promise<void> {
  const all = await ctx.db.categories(ctx.userId, true);
  const period = monthOf(todayIn(ctx.tz));
  const totals = await ctx.db.byCategory(ctx.userId, monthStart(period), monthEnd(period));
  const spentBy = new Map(totals.map((t) => [t.category_id, t.total]));

  const kb = new InlineKeyboard();
  all.forEach((c, i) => {
    const mark = c.archived ? '💤' : '';
    kb.text(`${mark}${c.emoji} ${c.name}`.trim(), `cat:${c.id}`);
    if ((i + 1) % 2 === 0) kb.row();
  });
  kb.row().text('➕ Add category', 'cats:add');

  const lines = all.length
    ? all.map((c) => {
        const spent = spentBy.get(c.id) ?? 0;
        const suffix = c.archived ? ' <i>(archived)</i>' : '';
        return `${c.emoji} ${escapeHtml(c.name)} — ${money(spent, ctx.sign)}${suffix}`;
      })
    : ['No categories yet.'];

  const text = `<b>Categories</b> · this month\n${lines.join('\n')}\n\nTap one to rename, budget, archive or delete.`;
  if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

categories.command('cats', async (ctx) => renderList(ctx));
categories.command('categories', async (ctx) => renderList(ctx));

categories.callbackQuery('cats:list', async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderList(ctx, true);
});

categories.callbackQuery('cats:add', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.db.setState(ctx.userId, 'cat_new');
  await ctx.reply(
    'Send the new category name. You can start it with an emoji:\n<code>🎁 Gifts</code>\n\n/cancel to stop.',
    { parse_mode: 'HTML' },
  );
});

categories.callbackQuery(/^cat:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  await ctx.answerCallbackQuery();
  await renderDetail(ctx, id, true);
});

async function renderDetail(ctx: AppContext, id: number, edit: boolean): Promise<void> {
  const category = await ctx.db.category(ctx.userId, id);
  if (!category) {
    await ctx.reply('That category is gone.');
    return;
  }
  const period = monthOf(todayIn(ctx.tz));
  const spent = await ctx.db.totalForCategory(
    ctx.userId,
    id,
    monthStart(period),
    monthEnd(period),
  );
  const budget = await ctx.db.budget(ctx.userId, id);
  const uses = await ctx.db.categoryUsage(ctx.userId, id);

  const kb = new InlineKeyboard()
    .text('✏️ Rename', `cat:${id}:rename`)
    .text('🎯 Budget', `bud:cat:${id}`)
    .row()
    .text(category.archived ? '♻️ Unarchive' : '💤 Archive', `cat:${id}:arch`)
    .text('🗑 Delete', `cat:${id}:del`)
    .row()
    .text('⬅️ Back', 'cats:list');

  const text = [
    `<b>${category.emoji} ${escapeHtml(category.name)}</b>`,
    `This month: <b>${money(spent, ctx.sign)}</b>`,
    budget ? `Budget: ${money(budget, ctx.sign)}` : 'Budget: not set',
    `Expenses recorded: ${uses}`,
  ].join('\n');

  if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

categories.callbackQuery(/^cat:(\d+):rename$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const category = await ctx.db.category(ctx.userId, id);
  if (!category) {
    await ctx.answerCallbackQuery({ text: 'Gone.', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.db.setState(ctx.userId, 'cat_rename', { id });
  await ctx.reply(
    `Send the new name for <b>${category.emoji} ${escapeHtml(category.name)}</b>.\nA leading emoji replaces the icon.\n\n/cancel to stop.`,
    { parse_mode: 'HTML' },
  );
});

categories.callbackQuery(/^cat:(\d+):arch$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const category = await ctx.db.category(ctx.userId, id);
  if (!category) {
    await ctx.answerCallbackQuery({ text: 'Gone.', show_alert: true });
    return;
  }
  await ctx.db.setArchived(ctx.userId, id, category.archived === 0);
  await ctx.answerCallbackQuery({ text: category.archived ? 'Back in use' : 'Archived' });
  await renderDetail(ctx, id, true);
});

categories.callbackQuery(/^cat:(\d+):del$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const category = await ctx.db.category(ctx.userId, id);
  if (!category) {
    await ctx.answerCallbackQuery({ text: 'Gone.', show_alert: true });
    return;
  }
  const uses = await ctx.db.categoryUsage(ctx.userId, id);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `Delete <b>${category.emoji} ${escapeHtml(category.name)}</b>?\n` +
      (uses > 0
        ? `${uses} expense(s) keep their amounts but lose this label. Archiving keeps history tidy instead.`
        : 'It has no expenses.'),
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('🗑 Delete', `cat:${id}:del:yes`)
        .text('⬅️ Keep', `cat:${id}`),
    },
  );
});

categories.callbackQuery(/^cat:(\d+):del:yes$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  await ctx.db.deleteCategory(ctx.userId, id);
  await ctx.answerCallbackQuery({ text: 'Deleted' });
  await renderList(ctx, true);
});

/** Called from the state router when the user sends a new category name. */
export async function handleNewCategoryName(ctx: AppContext, raw: string): Promise<void> {
  const { emoji, name } = splitEmoji(raw);
  if (!name) {
    await ctx.reply('Name cannot be empty. Send a name or /cancel.');
    return;
  }
  const created = await ctx.db.addCategory(ctx.userId, name, emoji);
  await ctx.db.clearState(ctx.userId);
  if (!created) {
    await ctx.reply(`A category named <b>${escapeHtml(name)}</b> already exists.`, {
      parse_mode: 'HTML',
    });
    return;
  }
  await ctx.reply(`Added <b>${created.emoji} ${escapeHtml(created.name)}</b>.`, {
    parse_mode: 'HTML',
  });
  await renderList(ctx);
}

/** Called from the state router when the user sends a replacement name. */
export async function handleRenameCategory(
  ctx: AppContext,
  id: number,
  raw: string,
): Promise<void> {
  const { emoji, name } = splitEmoji(raw);
  if (!name) {
    await ctx.reply('Name cannot be empty. Send a name or /cancel.');
    return;
  }
  const ok = await ctx.db.renameCategory(ctx.userId, id, name, emoji || undefined);
  await ctx.db.clearState(ctx.userId);
  if (!ok) {
    await ctx.reply('That name is taken by another category.');
    return;
  }
  await ctx.reply(`Renamed to <b>${emoji} ${escapeHtml(name)}</b>.`, { parse_mode: 'HTML' });
  await renderList(ctx);
}

const LEADING_EMOJI = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*/u;

export function splitEmoji(raw: string): { emoji: string; name: string } {
  const text = raw.trim().replace(/\s+/g, ' ');
  const m = LEADING_EMOJI.exec(text);
  if (m) return { emoji: m[1]!, name: text.slice(m[0].length).trim().slice(0, 32) };
  return { emoji: '', name: text.slice(0, 32) };
}
