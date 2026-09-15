import { dashboard } from './handlers/dashboard';
import { income } from './handlers/income';
import { categoryReview } from './handlers/category-review';
import type { BackgroundWork } from './database';
import { channelCommands, handleChannelPost } from './handlers/channel';
import { goals } from './handlers/goals';
import { daily } from './handlers/daily';
import { Bot, type BotConfig } from 'grammy';
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
  { command: 'dashboard', description: 'Interactive charts and money management' },
  { command: 'income', description: 'Record income and view sources' },
  { command: 'uncategorized', description: 'Assign categories to unknown items' },
  { command: 'today', description: 'Today spending and savings' },
  { command: 'yesterday', description: 'Yesterday spending and savings' },
  { command: 'week', description: 'Seven daily spending and savings bars' },
  { command: 'compare', description: 'Compare two completed weeks' },
  { command: 'chart', description: 'Daily spending and savings PDF' },
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
    await next();
  });

  // A command or a menu tap abandons any pending question, so the answer to
  // "send me the new name" cannot be picked up half an hour later.
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (text && (text.startsWith('/') || /^(📊|📈|🗂|🎯|📄|↩️)/u.test(text))) {
      await ctx.db.clearState(ctx.userId);
    }
    await next();
  });

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
