import { todayIn } from '../lib/dates';
import { accountEntry } from '../lib/account-entry';
import { Composer } from 'grammy';
import type { AppContext } from '../context';
import type { Db } from '../db';
import { parseDailyPost } from '../lib/daily-post';
import { matchCategory } from '../lib/parse';
import { checkBudgets } from '../lib/alerts';
import type { SyncedRow } from '../finance-db';

export const channelCommands = new Composer<AppContext>();
channelCommands.command('linkchannel', async ctx => {
  const arg = ctx.match.trim();
  if (!/^(-100\d+|@[A-Za-z0-9_]+)$/.test(arg)) {
    await ctx.reply('Add me as a channel admin, then use /linkchannel -1001234567890 or /linkchannel @channelname. For a private channel, forward a post here to get its ID.');
    return;
  }
  try {
    const chat = await ctx.api.getChat(arg.startsWith('@') ? arg : Number(arg));
    if (chat.type !== 'channel') { await ctx.reply('Please choose a channel.'); return; }
    const [owner, bot] = await Promise.all([ctx.api.getChatMember(chat.id,ctx.userId),ctx.api.getChatMember(chat.id,ctx.me.id)]);
    if (!['creator','administrator'].includes(owner.status) || bot.status !== 'administrator' || !bot.can_post_messages || !bot.can_edit_messages) {
      await ctx.reply('Both you and the bot must be administrators. Give the bot permission to post and edit messages.'); return;
    }
    const ok = await ctx.db.finance.link(chat.id,ctx.userId,chat.title);
    await ctx.reply(ok ? `Linked ${chat.title}. New posts and edits will sync to your account. Use /today to check them. Older posts must be edited to trigger syncing; they are not imported automatically.` : 'This channel is already linked to another account.');
  } catch { await ctx.reply('Could not verify the channel. Check its ID and that the bot is an admin.'); }
});
channelCommands.command('channels', async ctx => {
  const rows = await ctx.db.finance.channels(ctx.userId);
  await ctx.reply(rows.length ? rows.map(c=>`${c.title}: ${c.chat_id}`).join('\n') + '\n/unlinkchannel ID stops syncing and keeps history.' : 'No channel linked. Use /linkchannel.');
});
channelCommands.command('unlinkchannel', async ctx => {
  if (!/^-100\d+$/.test(ctx.match.trim())) { await ctx.reply('Use /unlinkchannel -1001234567890'); return; }
  await ctx.db.finance.unlink(ctx.userId,Number(ctx.match.trim()));
  await ctx.reply('Channel unlinked. Recorded history is preserved.');
});
channelCommands.on('message:forward_origin', async (ctx,next) => {
  const origin = ctx.message.forward_origin;
  if (origin.type !== 'channel') return next();
  await ctx.reply(`Channel ID: ${origin.chat.id}\nLink it with /linkchannel ${origin.chat.id}\nForwarding does not import an expense.`);
});

export async function handleChannelPost(ctx: AppContext, db: Db, allowlist: Set<number>, sign: string, suppliedPost?: import('grammy/types').Message): Promise<boolean> {
  const post = suppliedPost ?? ctx.update.channel_post ?? ctx.update.edited_channel_post;
  if (!post) return false;
  const linked = await db.finance.channel(post.chat.id);
  if (!linked || (allowlist.size > 0 && !allowlist.has(linked.user_id))) return true;
  // Service messages and reports are never finance inputs.
  if ((post.from?.is_bot && post.from.id!==ctx.me.id) || post.via_bot) return true;
  const previous = await db.finance.post(post.chat.id,post.message_id);
  if (post.text?.startsWith('/') && !previous) return true;
  if (!post.text && !post.caption && !post.rich_message && !previous) return true;
  const tz = await db.ensureUser(linked.user_id);
  let parsed;
  let rows: SyncedRow[] = [];
  let error: string | null = null;
  const setups: Array<{name:string;amount:number}>=[];
  try {
    parsed = parseDailyPost(post,tz);
    if(parsed.day>todayIn(tz)) throw new Error('Use today or a past date for recorded activity.');
    for (const row of parsed.rows.filter(r=>r.kind==='account')) {
      const account = accountEntry(row.label);
      if (!account.label || account.label.length>60) throw new Error('Account names must be 1–60 characters.');
      if (account.accountName) throw new Error('Account rows do not need “@ Account”: use account:Card | 100000.');
      const existing=await db.accounts.named(linked.user_id,account.label,true);
      if(existing && (existing.opening_minor!==row.amountMinor || existing.opening_on!==parsed.day)) throw new Error('Account already exists with a different opening balance or date. Edit it in /dashboard.');
      if(setups.some(a=>a.name.toLowerCase()===account.label.toLowerCase())) throw new Error('Use only one setup row per account.');
      if(!existing) setups.push({name:account.label,amount:row.amountMinor});
    }
    const [categories,aliases,goals,accounts,accountNames] = await Promise.all([db.categories(linked.user_id),db.finance.aliases(linked.user_id),db.finance.goals(linked.user_id),db.accounts.list(linked.user_id,parsed.day),db.accounts.aliases(linked.user_id)]);
    rows = parsed.rows.map((row): SyncedRow | null => {
      if (row.kind==='account') return null;
      const entry=accountEntry(row.label);
      const account=entry.accountName?accounts.find(a=>a.name.toLowerCase()===entry.accountName!.toLowerCase()||accountNames.some(n=>n.account_id===a.id&&n.name.toLowerCase()===entry.accountName!.toLowerCase())):null;
      const setup=entry.accountName?setups.find(a=>a.name.toLowerCase()===entry.accountName!.toLowerCase()):null;
      if(account?.archived) throw new Error('Choose an active account.');
      if (entry.accountName&&!account&&!setup) throw new Error('Unknown account: '+entry.accountName+'. Create it with /account or in the dashboard.');
      if (!entry.accountName && accounts.filter(a=>!a.archived).length+setups.length!==1) throw new Error('This row needs an account. Add “ @ Account” to the item, then edit the channel post.');
      if(row.kind==='income'&&!account&&!setup&&accounts.filter(a=>!a.archived).length+setups.length!==1) throw new Error('Income needs a receiving account. Use income:Salary @ Card and create Card in /dashboard or /account.');
      const accountId=account?.id ?? (!entry.accountName&&accounts.filter(a=>!a.archived).length===1?accounts.find(a=>!a.archived)!.id:undefined);
      const accountName=setup?.name ?? (!entry.accountName&&setups.length===1?setups[0]!.name:undefined);
      if (row.kind === 'income') return {categoryId:null,label:entry.label,amount:row.amountMinor,income:true,accountId,accountName,passive:entry.passive};
      row.label=entry.label;
      if (row.kind !== 'expense') {
        const goal = goals.find(g=>g.name.toLowerCase()===row.label.toLowerCase());
        if (!goal) throw new Error(`Unknown savings goal: ${row.label}. Create it with /goal first.`);
        return {categoryId:null,label:row.label,amount:row.amountMinor*(row.kind==='withdraw'?-1:1),goalId:goal.id,accountId,accountName};
      }
      const alias = aliases.find(a=>a.label.toLowerCase()===row.label.toLowerCase());
      const categoryId = alias && categories.some(c=>c.id===alias.category_id) ? alias.category_id : matchCategory(row.label,categories).category?.id ?? null;
      return {categoryId,label:row.label,amount:row.amountMinor/100,accountId,accountName};
    }).filter((row): row is SyncedRow => row !== null);
  } catch (err) { error = err instanceof Error ? err.message : 'Could not read this post.'; }
  let changed: boolean;
  try { changed = await db.finance.syncPost(linked.user_id,post.chat.id,post.message_id,post.edit_date ?? post.date,ctx.update.update_id,error?null:parsed!.day,rows,error,setups,Boolean(suppliedPost),JSON.stringify({date:post.date,text:post.text,caption:post.caption,entities:post.entities,caption_entities:post.caption_entities,rich_message:post.rich_message})); }
  catch (err) {
    if (!(err instanceof Error) || !/CHECK constraint failed/.test(err.message)) throw err;
    error = 'This edit would make a savings balance negative. Correct the savings rows first.';
    changed = await db.finance.syncPost(linked.user_id,post.chat.id,post.message_id,post.edit_date ?? post.date,ctx.update.update_id,null,[],error);
  }
  if (!changed) return true;
  if (error) {
    await ctx.api.sendMessage(linked.user_id,`Could not sync channel post #${post.message_id}: ${error}\nThe last valid records are preserved. Correct the post and edit again.`);
  } else {
    if (parsed!.warning) await ctx.api.sendMessage(linked.user_id,`Post #${post.message_id}: ${parsed!.warning}`);
    for (const category of new Set(rows.filter(r=>r.goalId===undefined&&!r.income).map(r=>r.categoryId))) {
      await checkBudgets(db,ctx.api,linked.user_id,linked.user_id,parsed!.day,category,sign);
    }
  }
  return true;
}

channelCommands.command('forgetpost', async ctx => {
  const m = /^(-100\d+)\s+(\d+)$/.exec(ctx.match.trim());
  if (!m) { await ctx.reply('Use /forgetpost CHANNEL_ID MESSAGE_ID to remove a deleted channel post from your records.'); return; }
  try {
    await ctx.db.finance.forgetPost(ctx.userId,Number(m[1]),Number(m[2]));
    await ctx.reply('Removed that post’s records. Editing the original post again will reimport it.');
  } catch { await ctx.reply('Cannot remove it because this would make a savings balance negative. Correct withdrawals first.'); }
});
