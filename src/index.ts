import { webhookCallback } from 'grammy';
import { createBot, COMMANDS } from './bot';
import { Db, OVERALL } from './db';
import { monthLabel, monthOf, shiftMonth, todayIn } from './lib/dates';
import { monthReport } from './handlers/stats';
import { money } from './lib/money';
import type { Env } from './types';

const WEBHOOK_PATH = '/telegram/webhook';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    }

    if (url.pathname === WEBHOOK_PATH && request.method === 'POST') {
      if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) {
        return new Response('not configured', { status: 500 });
      }
      const bot = createBot(env, ctx);
      const handle = webhookCallback(bot, 'cloudflare-mod', {
        secretToken: env.WEBHOOK_SECRET,
        timeoutMilliseconds: 55_000,
      });
      try {
        return await handle(request);
      } catch (err) {
        // Never make Telegram retry: a failed update is logged and dropped.
        console.error('webhook error', err);
        return new Response('ok');
      }
    }

    return new Response('not found', { status: 404 });
  },

  /**
   * Daily tick. On the 1st of a user's local month it sends the closing
   * summary of the month that just ended.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDaily(env, ctx));
  },
} satisfies ExportedHandler<Env>;

async function runDaily(env: Env, ctx: ExecutionContext): Promise<void> {
  const db = new Db(env.DB, env.DEFAULT_TZ || 'Asia/Yerevan');
  const bot = createBot(env, ctx);
  await bot.init();
  await bot.api.setMyCommands(COMMANDS).catch(() => undefined);

  const sign = env.CURRENCY_SIGN || '֏';
  for (const user of await db.listUsers()) {
    const today = todayIn(user.tz);
    if (!today.endsWith('-01')) continue;

    const closed = shiftMonth(monthOf(today), -1);
    try {
      const report = await monthReport(db, user.id, closed, user.tz, sign);
      const limit = await db.budget(user.id, OVERALL);
      const tail = limit
        ? `\n\nNew month, budget back to ${money(limit, sign)}.`
        : '\n\nNew month. Set a limit with /budget.';
      await bot.api.sendMessage(user.id, `📅 <b>${monthLabel(closed)} closed</b>\n\n${report}${tail}`, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '📄 PDF report', callback_data: `export:pdf:${closed}` }]],
        },
      });
    } catch (err) {
      console.error('monthly summary failed', user.id, err);
    }
  }
}
