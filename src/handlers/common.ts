import { Composer } from 'grammy';
import type { AppContext } from '../context';
import { MAIN_MENU } from '../lib/keyboards';

export const common = new Composer<AppContext>();

const HELP = `<b>FinTrack</b> — spending in one line.

<b>Guided entry</b>
/add — choose an item, account and amount using buttons and a keypad
/income — record income step by step; /incomes shows recent receipts
/save or /withdraw — choose a savings goal, account and amount
/new — choose any entry type
/account — guided account setup; /accounts to edit balances and settings
/goal — create or edit savings plans with buttons
/resume — continue an unfinished draft, even after browsing reports
/transfer — move recorded money between accounts; /transfers to review or undo
/bill — set up a weekly or monthly bill reminder; /bills to edit or pause
/savings — review, correct or undo savings deposits and withdrawals

<b>Quick text entry (optional)</b>
<code>1500 cafe latte</code>
<code>cafe 1500</code>
<code>2.5k transport</code>
<code>yesterday 12,000 groceries</code>
<code>03.09 45000 rent</code>

Amount first or last, both work. <code>k</code> = thousand, <code>m</code> = million.
Create an account first with /account. Every expense and savings transfer needs an account. Add @ Card or use the account picker.
No category in the text? The bot asks with one tap.
Guided entry warns about matching entries before saving. Choose Save anyway only for a separate purchase or receipt.
Bill reminders record nothing until you confirm payment. Transfers never count as income or spending.

<b>Channel, daily reports and savings</b>
/add metro 150 @ Card — add spending to the channel table
/linkchannel — connect a channel where you and the bot are admins
/today /yesterday /week — spending and confirmed savings
/compare — two completed seven-day periods
/chart 30 — interactive income, spending and savings charts
/chartpdf 30 — PDF chart
/dashboard — export a read-only interactive HTML report
/account Card 100000 — create an account with an opening balance
/accounts — recorded account balances
/income Salary @ Card 450000 — record received income
/goal — savings goals; /goalhelp for setup examples
/save laptop 5500 @ Card — confirm money moved to savings
/withdraw laptop 2000 @ Card — record money taken back out
/funding shared 20000 — shared budget with a protected reserve
/remind 20:00 /summary 21:00 — optional daily notifications
/uncategorized — assign unknown items to existing or new categories
/alias chatgpt, cigarette, coffee | Personal — remember several item categories at once
/syncstatus — posts needing correction
/forgetpost CHANNEL_ID MESSAGE_ID — remove a deleted post's records

Edit your daily channel table to correct amounts or remove rows. Savings rows use save:laptop @ Card or withdraw:laptop @ Card as the item. Income rows use income:Salary @ Card. Add [passive] after the account name for passive income. Totals are calculated from expense rows, excluding savings transfers.
Create an account from a channel table with <code>account:Card | 100000</code>; it is setup data and is not counted as spending.

<b>Commands</b>
/month — this month, by category
/stats — last 6 months + top categories
/last — recent expenses, with delete buttons
/cats — add, rename, archive, delete categories
/budget — monthly limit, overall or per category
/export — PDF report with charts, or CSV
/undo — remove the last expense
/tz — set your timezone (default Asia/Yerevan)
/cleanup — permanently erase your data after confirmation
/help — this text

<b>Alerts</b>
When a budget hits 80%, 100%, 120%, 150% or 200%, the bot messages you once per level per month.`;

common.command('start', async (ctx) => {
  await ctx.reply(
    `Hi 👋 Tap ➕ Add entry or send /add. Choose an item and account, then use the amount keypad. You can also type <code>1500 cafe latte</code>.\n\nSend /help for everything else.`,
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
