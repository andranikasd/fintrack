import { entryHistory } from './handlers/entry-history';
import { financeForms } from './handlers/finance-forms';
import { drafts } from './handlers/drafts';
import { bills } from './handlers/bills';
import { transfers } from './handlers/transfers';
import { guidedEntry } from './handlers/guided-entry';
import { cleanup } from './handlers/cleanup';
import { dashboard } from './handlers/dashboard';
import { income } from './handlers/income';
import { categoryReview } from './handlers/category-review';
import type { BackgroundWork } from './database';
import { channelCommands, handleChannelPost } from './handlers/channel';
import { goals } from './handlers/goals';
import { daily } from './handlers/daily';
import { Bot, InlineKeyboard, type BotConfig } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { AppContext } from './context';
import { Db } from './db';
import { budget } from './handlers/budget';
import { categories } from './handlers/categories';
import { common } from './handlers/common';
import { entry } from './handlers/entry';
import { exportData } from './handlers/export';
import { menu } from './handlers/menu';
import { states } from './handlers/states';
import { stats } from './handlers/stats';
import type { Env } from './types';

export const COMMANDS = [
  {command:'edit',description:'Find and edit any past entry'},
  {command:'history',description:'Search all recorded entries by item or date'},
  {command:'resume',description:'Continue an unfinished entry or setup'},
  {command:'drafts',description:'View and discard unfinished drafts'},
  {command:'transfer',description:'Record a transfer between your accounts'},
  {command:'transfers',description:'Review or undo account transfers'},
  {command:'bill',description:'Set up a recurring payment reminder'},
  {command:'bills',description:'Review and edit recurring bills'},
  {command:'savings',description:'Review and correct savings activity'},
  { command: 'add', description: 'Record an expense step by step' },
  { command: 'new', description: 'Guided expense, income or savings entry' },
  { command: 'incomes', description: 'View income sources and recent receipts' },
  { command: 'dashboard', description: 'Export an interactive report' },
  { command: 'account', description: 'Create an account with an opening balance' },
  { command: 'accounts', description: 'View recorded account balances' },
  { command: 'income', description: 'Record income step by step' },
  { command: 'uncategorized', description: 'Assign categories to unknown items' },
  { command: 'today', description: 'Today spending and savings' },
  { command: 'yesterday', description: 'Yesterday spending and savings' },
  { command: 'week', description: 'Seven daily spending and savings bars' },
  { command: 'compare', description: 'Compare two completed weeks' },
  { command: 'chart', description: 'Interactive income and spending charts' },
  { command: 'chartpdf', description: 'Daily spending and savings PDF' },
  { command: 'goal', description: 'Savings goals and plans' },
  { command: 'save', description: 'Confirm a savings contribution' },
  { command: 'withdraw', description: 'Record a savings withdrawal' },
  { command: 'funding', description: 'Shared or separate savings budget' },
  { command: 'remind', description: 'Set daily savings reminder time' },
  { command: 'summary', description: 'Set daily summary time' },
  { command: 'linkchannel', description: 'Link an expense channel' },
  { command: 'channels', description: 'List linked channels' },
  { command: 'syncstatus', description: 'Check channel parsing errors' },
  { command: 'alias', description: 'Teach an item category' },

  { command: 'month', description: 'This month by category' },
  { command: 'stats', description: 'Last 6 months' },
  { command: 'last', description: 'Recent expenses' },
  { command: 'cats', description: 'Manage categories' },
  { command: 'budget', description: 'Monthly limits' },
  { command: 'export', description: 'PDF or CSV report' },
  { command: 'undo', description: 'Remove the last expense' },
  { command: 'tz', description: 'Set your timezone' },
  { command: 'cleanup', description: 'Erase your data after confirmation' },
  { command: 'help', description: 'How to use the bot' },
];

function allowedIds(env: Env): Set<number> {
  return new Set(
    (env.ALLOWED_USER_IDS ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
  );
}

export function createBot(env: Env, exec: BackgroundWork): Bot<AppContext> {
  const config: BotConfig<AppContext> = {};
  if (env.BOT_INFO) {
    config.botInfo = JSON.parse(env.BOT_INFO) as UserFromGetMe;
  }
  const bot = new Bot<AppContext>(env.BOT_TOKEN, config);
  const allowlist = allowedIds(env);
  const db = new Db(env.DB, env.DEFAULT_TZ || 'Asia/Yerevan');

  bot.use(async (ctx, next) => {
    if (await handleChannelPost(ctx, db, allowlist, env.CURRENCY_SIGN || '֏')) return;
    if (ctx.chat?.type !== 'private') return;
    const from = ctx.from;
    if (!from || from.is_bot) return;
    if (allowlist.size > 0 && !allowlist.has(from.id)) {
      if (ctx.chat) await ctx.reply('This bot is private.');
      return;
    }
    ctx.env = env;
    ctx.db = db;
    ctx.exec = exec;
    ctx.sign = env.CURRENCY_SIGN || '֏';
    ctx.userId = from.id;
    ctx.tz = await db.ensureUser(from.id);
    try { await next(); }
    catch(error) {
      console.error('Private update failed',error);
      await ctx.reply(error instanceof Error && /account|Insufficient funds|positive|ledger|Telegram|channel message/i.test(error.message)
        ? error.message : 'Could not complete this request. Check /last, /goal or /syncstatus before retrying.',{reply_markup:new InlineKeyboard().text('Check recent activity','entry:check').row().text('Guided entry','entry:new')});
    }
  });

  // Commands and navigation release the text-answer slot but retain unfinished forms.
  bot.use(async(ctx,next)=>{
    const text=ctx.message?.text,callback=ctx.callbackQuery?.data;
    const menu=['➕ Expense','💰 Income','➕ Add entry','🧾 Recent','🏦 Accounts','📄 Export','🗂 Categories','🎯 Budget','📊 Month','📈 Stats','↩️ Undo'];
    const navigating=Boolean(text&&(text.startsWith('/')||menu.includes(text))||callback&&/^(history:open|new:|entry:new$|setup:|correct:|income:recent$|expense:recent$|bills:list$|transfers:list$|savings:recent$|transfer:undo:|drafts:list$|saving:(?:yes|other|skip):|cats:|cat:|bud:|review:new:)/.test(callback));
    if(navigating){
      const cancelled=Boolean(text&&/^\/cancel(?:@\w+)?(?:\s|$)/.test(text));
      const paused=cancelled?null:await ctx.db.pauseDraft(ctx.userId);
      await ctx.db.clearState(ctx.userId);
      if(paused&&!['/resume','/drafts'].includes(text??'')&&callback!=='drafts:list')await ctx.reply('Your unfinished draft is saved.',{reply_markup:new InlineKeyboard().text('Continue draft',`resume:${paused}`).text('All drafts','drafts:list')});
    }
    await next();
  });

  bot.use(cleanup);
  bot.use(drafts);
  bot.use(financeForms);
  bot.use(bills);
  bot.use(transfers);
  bot.use(entryHistory);
  bot.use(guidedEntry);
  bot.use(channelCommands);
  bot.use(goals);
  bot.use(dashboard);
  bot.use(daily);
  bot.use(income);
  bot.use(categoryReview);
  bot.use(common);
  bot.use(menu);
  bot.use(categories);
  bot.use(budget);
  bot.use(stats);
  bot.use(exportData);
  bot.use(states);
  bot.use(entry); // free-text expense entry, last on purpose

  bot.catch((err) => {
    console.error('bot error', err.error);
    if (err.ctx.update.channel_post || err.ctx.update.edited_channel_post) throw err;
  });

  return bot;
}
