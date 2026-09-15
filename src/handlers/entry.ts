import { appendChannelExpense } from '../lib/channel-table';
import { handleChannelPost } from './channel';
import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context';
import { OVERALL } from '../db';
import { checkBudgets, paceLine } from '../lib/alerts';
import { monthEnd, monthOf, monthStart, prettyDate, todayIn } from '../lib/dates';
import { categoryKeyboard } from '../lib/keyboards';
import { financialStatus } from '../lib/finance';
import { minorMoney } from '../lib/savings';
import { money } from '../lib/money';
import { matchCategory, parseEntry } from '../lib/parse';
import { accountEntry } from '../lib/account-entry';
import type { TxWithCategory } from '../types';

export const entry = new Composer<AppContext>();

/** Telegram Markdown does not render pipe tables. Rich messages do, so channel
 * rows created by /add use Telegram's native table block when available. */
function richDailyTable(day: string, rows: Array<[string, string]>, total: number) {
  const cell = (text: string, isHeader = false) => ({
    text,
    ...(isHeader ? { is_header: true as const } : {}),
    align: 'left' as const,
    valign: 'middle' as const,
  });
  return {
    blocks: [
      { type: 'paragraph' as const, text: day },
      {
        type: 'table' as const,
        is_bordered: true as const,
        is_striped: true as const,
        cells: [
          [
            cell('Item', true),
            cell('price', true),
          ],
          ...rows.map(([label, amount]) => [cell(label), cell(amount, false)]),
        ],
      },
      { type: 'paragraph' as const, text: `Total: ${total}` },
    ],
  };
}

function accountKeyboard(accounts: Array<{id:number;name:string}>, prefix:string, request:string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const account of accounts) kb.text(account.name, `${prefix}:${account.id}:${request}`).row();
  return kb;
}

async function addToChannel(ctx: AppContext, parsed: {amount:number; rest:string; spentOn:string;event?:string}, accountId: number): Promise<void> {
  const account = await ctx.db.accounts.get(ctx.userId, accountId);
  if (!account || account.archived) { await ctx.reply('That account is unavailable. Use /accounts and try again.'); return; }
  const channels=await ctx.db.finance.channels(ctx.userId);
  if(channels.length>1) { await ctx.reply('More than one channel is linked. Keep one linked channel for /add so the destination is unambiguous.'); return; }
  const linked = channels[0];
  if (!linked) { await ctx.reply('Link a finance channel first with /linkchannel.'); return; }
  const raw = accountEntry(parsed.rest);
  const label = raw.label.trim();
  if (!label) { await ctx.reply('Add an item name, for example /add metro 150.'); return; }
  const categories = await ctx.db.categories(ctx.userId);
  const matched = matchCategory(label, categories);
  const item = matched.note ? `${matched.category?.name ?? ''} ${matched.note}`.trim() : label;
  const suffix = ` @ ${account.name}`;
  const event=parsed.event ?? `add:${ctx.userId}:${ctx.message!.message_id}`;
  // Recover the channel lock after a crashed request; never replay that request.
  await ctx.env.DB.prepare("UPDATE channel_add_requests SET status='uncertain' WHERE chat_id=? AND status='pending' AND started_at<unixepoch()-600").bind(linked.chat_id).run();
  let claimed;
  try { claimed=await ctx.env.DB.prepare("INSERT INTO channel_add_requests(event_key,user_id,chat_id,status) VALUES(?,?,?,'pending') ON CONFLICT(event_key) DO NOTHING").bind(event,ctx.userId,linked.chat_id).run(); }
  catch(error) { if(error instanceof Error && /UNIQUE/.test(error.message)) { await ctx.reply('Another /add is still updating this channel. Try again after it finishes.'); return; } throw error; }
  if(!claimed.meta.changes) { await ctx.reply('This /add request was already handled or attempted. Check the channel and /syncstatus before sending a new command.'); return; }
  let completed=false;
  try {
  const post = await ctx.db.finance.latestPostForDay(ctx.userId, parsed.spentOn, linked.chat_id);
  async function importSent(message: import('grammy/types').Message) {
    if(!message || !Number.isInteger(message.message_id)) throw new Error('Telegram did not confirm the channel message.');
    await handleChannelPost(ctx,ctx.db,new Set([ctx.userId]),ctx.sign,message);
    const status=await ctx.db.finance.post(message.chat.id,message.message_id);
    if(!status || status.error) throw new Error(status?.error || 'Channel message was sent but could not be imported. Edit it to retry.');
    await ctx.env.DB.prepare('UPDATE channel_posts SET bot_managed=1 WHERE user_id=? AND chat_id=? AND message_id=?').bind(ctx.userId,message.chat.id,message.message_id).run();
  }
  if (post) {
    if(!post.content) throw new Error('Edit the original channel post once so the bot can preserve its formatting, then use /add again.');
    const next=appendChannelExpense(JSON.parse(post.content),ctx.tz,`${item}${suffix}`,parsed.amount);
    const edited=next.rich
      ? await ctx.api.editMessageText(post.chat_id,post.message_id,next.rich)
      : next.caption
      ? await ctx.api.editMessageCaption(post.chat_id,post.message_id,{caption:next.text,caption_entities:next.entities})
      : await ctx.api.editMessageText(post.chat_id,post.message_id,next.text!,{entities:next.entities});
    if(typeof edited==='boolean') throw new Error('Telegram did not return the edited channel message. Check /syncstatus.');
    await importSent(edited);
    await ctx.reply(`Added ${parsed.amount} ֏ ${item} to the ${parsed.spentOn} channel table.`);
  } else {
    const sent = await ctx.api.sendRichMessage(linked.chat_id, richDailyTable(parsed.spentOn, [[`${item}${suffix}`, String(parsed.amount)]], parsed.amount));
    await importSent(sent);
    await ctx.reply(`Created the ${parsed.spentOn} channel table and added ${parsed.amount} ֏ ${item}.`);

  }
  completed=true;
  await ctx.db.clearState(ctx.userId);
  } finally {
    await ctx.env.DB.prepare('UPDATE channel_add_requests SET status=? WHERE event_key=? AND user_id=?').bind(completed?'done':'uncertain',event,ctx.userId).run();
  }
}

entry.command('add', async ctx => {
  const parsed = parseEntry(ctx.match.trim(), ctx.tz);
  if (!parsed) { await ctx.reply('Use /add metro 150 @ Card, or /add yesterday metro 150 @ Card.'); return; }
  const request=crypto.randomUUID().replaceAll('-','').slice(0,24);
  const raw = accountEntry(parsed.rest);
  const accounts = (await ctx.db.accounts.list(ctx.userId, parsed.spentOn)).filter(a=>!a.archived);
  if (!accounts.length) { await ctx.reply('Create an account first with /account Card 0, then use /add item amount @ Card.'); return; }
  const account = raw.accountName ? accounts.find(a=>a.name.toLowerCase()===raw.accountName!.toLowerCase()) : null;
  if (raw.accountName && !account) { await ctx.reply('Unknown account. Choose one:', {reply_markup:accountKeyboard(accounts,'addaccount',request)}); await ctx.db.setState(ctx.userId,'add_account',{request,amount:parsed.amount,rest:parsed.rest,spentOn:parsed.spentOn,event:`add:${ctx.userId}:${ctx.message!.message_id}`}); return; }
  if (!account) { await ctx.reply('Which account paid for this spending?', {reply_markup:accountKeyboard(accounts,'addaccount',request)}); await ctx.db.setState(ctx.userId,'add_account',{request,amount:parsed.amount,rest:parsed.rest,spentOn:parsed.spentOn,event:`add:${ctx.userId}:${ctx.message!.message_id}`}); return; }
  await addToChannel(ctx,parsed,account.id);
});

entry.callbackQuery(/^addaccount:(\d+):([a-f0-9]{24})$/, async ctx => {
  const state = await ctx.db.getState(ctx.userId);
  const accountId = Number(ctx.match[1]);
  if (!state || state.state !== 'add_account' || state.payload.request!==ctx.match[2]) { await ctx.answerCallbackQuery({text:'This request expired. Use /add again.',show_alert:true}); return; }
  await ctx.answerCallbackQuery();
  await ctx.db.clearState(ctx.userId);
  const p = state.payload;
  await addToChannel(ctx,{amount:Number(p.amount),rest:String(p.rest),spentOn:String(p.spentOn),event:String(p.event)},accountId);
});

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
  const status = await financialStatus(ctx.db,ctx.userId,today);
  const pace = status.prefs.funding === 'shared' || status.prefs.reserve_minor>0 ? (status.available === null ? null : `Available after savings/reserve: ${minorMoney(status.available,ctx.sign)}`) : paceLine(spent, budget, today, ctx.sign);
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

  const request=crypto.randomUUID().replaceAll('-','').slice(0,24);
  const accountHint = accountEntry(parsed.rest);
  const accounts = (await ctx.db.accounts.list(ctx.userId, parsed.spentOn)).filter(a=>!a.archived);
  const account = accountHint.accountName ? accounts.find(a=>a.name.toLowerCase()===accountHint.accountName!.toLowerCase()) : null;
  if (!accounts.length) { await ctx.reply('Create an account first: /account Card 100000.'); return; }
  if (!account) {
    await ctx.db.setState(ctx.userId,'entry_account',{request,amount:parsed.amount,rest:parsed.rest,spentOn:parsed.spentOn,event:`message:${ctx.chat.id}:${ctx.message.message_id}`});
    await ctx.reply(accountHint.accountName ? 'Unknown account. Choose the account that paid for this spending:' : 'Which account paid for this spending?', {reply_markup:accountKeyboard(accounts,'entryaccount',request)});
    return;
  }
  const categories = await ctx.db.categories(ctx.userId);
  const { category, note } = matchCategory(accountHint.label, categories);
  const txId = await ctx.db.addTransaction(
    ctx.userId,
    category?.id ?? null,
    parsed.amount,
    note,
    parsed.spentOn,
    account.id,
    `message:${ctx.chat.id}:${ctx.message.message_id}`,
  );
  await confirm(ctx, txId, category === null);
});

entry.callbackQuery(/^entryaccount:(\d+):([a-f0-9]{24})$/, async ctx => {
  const state = await ctx.db.getState(ctx.userId), accountId=Number(ctx.match[1]);
  if (!state || state.state!=='entry_account'||state.payload.request!==ctx.match[2]) { await ctx.answerCallbackQuery({text:'This request expired. Send the expense again.',show_alert:true}); return; }
  const account=await ctx.db.accounts.get(ctx.userId,accountId);
  if(!account||account.archived){await ctx.answerCallbackQuery({text:'Account unavailable.',show_alert:true});return;}
  await ctx.answerCallbackQuery();await ctx.db.clearState(ctx.userId);
  const categories=await ctx.db.categories(ctx.userId),match=matchCategory(String(state.payload.rest).replace(/\s+@\s+.+$/,''),categories);
  const txId=await ctx.db.addTransaction(ctx.userId,match.category?.id??null,Number(state.payload.amount),match.note,String(state.payload.spentOn),account.id,String(state.payload.event));
  await confirm(ctx,txId,match.category===null);
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
  if (tx.source_chat != null) await ctx.db.finance.alias(ctx.userId, tx.note, catId);
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
  await ctx.answerCallbackQuery({ text: ok ? 'Deleted' : 'Edit the source table to remove channel expenses; otherwise this is already gone.', show_alert: !ok });
  if (!ok) return;
  await ctx.editMessageText('🗑 <s>deleted</s>', { parse_mode: 'HTML' });
});

export async function undoLast(ctx: AppContext): Promise<void> {
  const txId = await ctx.db.lastTransactionId(ctx.userId);
  if (txId === null) {
    await ctx.reply('Nothing to undo.');
    return;
  }
  const tx = await ctx.db.transaction(ctx.userId, txId);
  if (tx?.source_chat != null) { await ctx.reply('Edit the source channel table to remove this expense.'); return; }
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
