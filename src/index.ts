import { runScheduled } from './schedule';
import { webhookCallback } from 'grammy';
import { createBot } from './bot';
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
      const update = await request.clone().json().catch(() => null) as {channel_post?: unknown; edited_channel_post?: unknown} | null;
      const isChannel = Boolean(update?.channel_post || update?.edited_channel_post);
      const bot = createBot(env, ctx);
      const handle = webhookCallback(bot, 'cloudflare-mod', {
        secretToken: env.WEBHOOK_SECRET,
        timeoutMilliseconds: 55_000,
      });
      try {
        return await handle(request);
      } catch (err) {
        // Channel ingestion is idempotent, so transient failures may be retried.
        // Preserve the existing no-retry behavior for legacy private expense entry.
        console.error('webhook error', err);
        return isChannel ? new Response('retry', {status: 500}) : new Response('ok');
      }
    }

    return new Response('not found', { status: 404 });
  },

  /**
   * Five-minute tick. On the 1st of a user's local month it sends the closing
   * summary of the month that just ended.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const bot = createBot(env, ctx);
      await bot.init();
      await runScheduled(env, bot.api);
    })());
  },
} satisfies ExportedHandler<Env>;
