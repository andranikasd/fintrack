import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context';

export const cleanup = new Composer<AppContext>();
cleanup.command('cleanup', async ctx => {
  const token=crypto.randomUUID();
  await ctx.db.setState(ctx.userId,'cleanup',{token,expires:Date.now()+5*60_000});
  await ctx.reply('This permanently erases all your FinTrack data: accounts, spending, income, savings, categories, budgets, reminders, attachments, history, settings and dashboard access. Channels will be disconnected. Telegram messages and existing backup files are not deleted. Other users are unaffected.\n\nThis cannot be undone in the bot. Confirm within five minutes.', {
    reply_markup:new InlineKeyboard().text('Erase all my data',`cleanup:${token}`).row().text('Cancel','cleanup:cancel'),
  });
});
cleanup.callbackQuery('cleanup:cancel',async ctx=>{
  await ctx.db.clearState(ctx.userId);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Cleanup cancelled. Your data is unchanged.');
});
cleanup.callbackQuery(/^cleanup:([a-f0-9-]{36})$/,async ctx=>{
  const removed=await ctx.db.cleanup(ctx.userId,ctx.match[1]!);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(removed?'Your FinTrack data has been erased. Send /start to set up again.':'Confirmation expired or was already used. Send /cleanup to try again.');
});
