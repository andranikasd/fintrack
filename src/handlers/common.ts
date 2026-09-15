import { Composer } from 'grammy';
import type { AppContext } from '../context';
import { MAIN_MENU } from '../lib/keyboards';

export const common = new Composer<AppContext>();

const HELP = `<b>FinTrack</b> — spending in one line.

<b>Log an expense</b>
Just type it:
<code>1500 cafe latte</code>
<code>cafe 1500</code>
<code>2.5k transport</code>
<code>yesterday 12,000 groceries</code>
<code>03.09 45000 rent</code>

Amount first or last, both work. <code>k</code> = thousand, <code>m</code> = million.
No category in the text? The bot asks with one tap.

<b>Channel, daily reports and savings</b>
/linkchannel — connect a channel where you and the bot are admins
/today /yesterday /week — spending and confirmed savings
/compare — two completed seven-day periods
/chart 30 — daily spending/savings PDF
/goal — savings goals; /goalhelp for setup examples
/save laptop 5500 — confirm money moved to savings
/withdraw laptop 2000 — record money taken back out
/funding shared 20000 — shared budget with a protected reserve
/remind 20:00 /summary 21:00 — optional daily notifications
/alias metro | Transport — remember an item category
/syncstatus — posts needing correction
/forgetpost CHANNEL_ID MESSAGE_ID — remove a deleted post's records

Edit your daily channel table to correct amounts or remove rows. Savings rows use save:laptop or withdraw:laptop as the item. Totals are calculated from expense rows, excluding savings transfers.

<b>Commands</b>
/month — this month, by category
/stats — last 6 months + top categories
/last — recent expenses, with delete buttons
/cats — add, rename, archive, delete categories
/budget — monthly limit, overall or per category
/export — PDF report with charts, or CSV
/undo — remove the last expense
/tz — set your timezone (default Asia/Yerevan)
/help — this text

<b>Alerts</b>
When a budget hits 80%, 100%, 120%, 150% or 200%, the bot messages you once per level per month.`;

common.command('start', async (ctx) => {
  await ctx.reply(
    `Hi 👋 Track spending by typing <code>1500 cafe latte</code>.\n\nSend /help for everything else.`,
    { parse_mode: 'HTML', reply_markup: MAIN_MENU },
  );
});

common.command('help', async (ctx) => {
  await ctx.reply(HELP, { parse_mode: 'HTML', reply_markup: MAIN_MENU });
});

common.command('cancel', async (ctx) => {
  await ctx.db.clearState(ctx.userId);
  await ctx.reply('Cancelled.', { reply_markup: MAIN_MENU });
});

common.command('tz', async (ctx) => {
  const arg = (ctx.match as string).trim();
  if (!arg) {
    await ctx.reply(
      `Timezone: <code>${ctx.tz}</code>\nChange it with <code>/tz Asia/Yerevan</code>`,
      { parse_mode: 'HTML' },
    );
    return;
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: arg }).format(new Date());
  } catch {
    await ctx.reply('Unknown timezone. Use an IANA name like <code>Asia/Yerevan</code>.', {
      parse_mode: 'HTML',
    });
    return;
  }
  await ctx.db.setTz(ctx.userId, arg);
  await ctx.reply(`Timezone set to <code>${arg}</code>.`, { parse_mode: 'HTML' });
});

common.callbackQuery('noop', async (ctx) => {
  await ctx.answerCallbackQuery();
});
