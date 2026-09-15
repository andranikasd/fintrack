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
    if (!['creator','administrator'].includes(owner.status) || bot.status !== 'administrator') {
      await ctx.reply('Both you and the bot must be administrators of this channel.'); return;
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

export async function handleChannelPost(ctx: AppContext, db: Db, allowlist: Set<number>, sign: string): Promise<boolean> {
  const post = ctx.update.channel_post ?? ctx.update.edited_channel_post;
  if (!post) return false;
  const linked = await db.finance.channel(post.chat.id);
  if (!linked || (allowlist.size > 0 && !allowlist.has(linked.user_id))) return true;
  // Service messages and reports are never finance inputs.
  if (post.from?.is_bot || post.via_bot) return true;
  const previous = await db.finance.post(post.chat.id,post.message_id);
  if (post.text?.startsWith('/') && !previous) return true;
  if (!post.text && !post.caption && !post.rich_message && !previous) return true;
  const tz = await db.ensureUser(linked.user_id);
  let parsed;
  let rows: SyncedRow[] = [];
  let error: string | null = null;
  try {
    parsed = parseDailyPost(post,tz);
    const [categories,aliases,goals] = await Promise.all([db.categories(linked.user_id),db.finance.aliases(linked.user_id),db.finance.goals(linked.user_id)]);
    rows = parsed.rows.map(row => {
      if (row.kind === 'income') return {categoryId:null,label:row.label,amount:row.amountMinor,income:true};
      if (row.kind !== 'expense') {
        const goal = goals.find(g=>g.name.toLowerCase()===row.label.toLowerCase());
        if (!goal) throw new Error(`Unknown savings goal: ${row.label}. Create it with /goal first.`);
        return {categoryId:null,label:row.label,amount:row.amountMinor*(row.kind==='withdraw'?-1:1),goalId:goal.id};
      }
      const alias = aliases.find(a=>a.label.toLowerCase()===row.label.toLowerCase());
      const categoryId = alias && categories.some(c=>c.id===alias.category_id) ? alias.category_id : matchCategory(row.label,categories).category?.id ?? null;
      return {categoryId,label:row.label,amount:row.amountMinor/100};
    });
  } catch (err) { error = err instanceof Error ? err.message : 'Could not read this post.'; }
  let changed: boolean;
  try { changed = await db.finance.syncPost(linked.user_id,post.chat.id,post.message_id,post.edit_date ?? post.date,ctx.update.update_id,error?null:parsed!.day,rows,error); }
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
