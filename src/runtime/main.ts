import { createServer } from 'node:http';
import { join } from 'node:path';
import { createBot, COMMANDS } from '../bot';
import { runScheduled } from '../schedule';
import type { Env } from '../types';
import { SqliteDatabase } from './sqlite';
import { loadConfig } from './config';
import { BackgroundTasks } from './background';
import { dailyBackup } from './backups';

async function main(): Promise<void> {
  process.umask(0o077);
  const config = loadConfig(process.env);
  const db = new SqliteDatabase(join(config.dataDir, 'fintrack.sqlite'));
  const migrations = db.migrate(process.env.MIGRATIONS_DIR || '/app/migrations', config.backupDir);
  if (migrations.length) console.log(`Applied migrations: ${migrations.join(', ')}`);
  const tasks = new BackgroundTasks();
  const env: Env = {
    DB: db, BOT_TOKEN: config.token, ALLOWED_USER_IDS: config.ids,
    DEFAULT_TZ: config.tz, CURRENCY: 'AMD', CURRENCY_SIGN: '֏', WEBHOOK_SECRET: '',
  };
  const bot = createBot(env, tasks);
  let lastPoll = 0;
  let lastSchedule = 0;
  let lastBackup = 0;
  let stopping = false;
  let pollingStarted = false;
  let tickRunning: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  bot.api.config.use(async (previous, method, payload, signal) => {
    const response = await previous(method, payload, signal);
    if (method === 'getUpdates' && response.ok) lastPoll = Date.now();
    return response;
  });

  const server = createServer((request, response) => {
    if (request.url !== '/healthz') { response.writeHead(404).end(); return; }
    const now = Date.now();
    let healthy = !stopping && pollingStarted && now - lastPoll < 180_000 &&
      now - lastSchedule < 600_000 && now - lastBackup < 26 * 3600_000;
    try { db.health(); } catch { healthy = false; }
    response.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: healthy ? 'ok' : 'starting-or-degraded' }));
  });
  // Health endpoint is local to the container and is not published by Compose.
  server.listen(8080, '127.0.0.1');

  const tick = async () => {
    try {
      await runScheduled(env, bot.api);
      lastSchedule = Date.now();
    } catch (error) {
      console.error('Scheduled jobs failed:', safeError(error));
    }
    try {
      await dailyBackup(db, config.backupDir, config.retention);
      lastBackup = Date.now();
    } catch (error) {
      console.error('Backup failed:', safeError(error));
    }
  };
  const startTick = () => {
    if (stopping || tickRunning) return;
    tickRunning = tick().finally(() => { tickRunning = null; });
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    console.log('Stopping polling and finishing outstanding reports…');
    if (pollingStarted) void bot.stop().catch(error => console.error('Polling stop failed:', safeError(error)));
    setTimeout(() => process.exit(1), 50_000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  try {
    await bot.init();
    if (stopping) return;
    // A bot token can use either webhooks or polling. Preserve all pending updates.
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    await bot.api.setMyCommands(COMMANDS);
    if (stopping) return;
    startTick();
    timer = setInterval(startTick, 60_000);
    await bot.start({
      allowed_updates: ['message', 'callback_query', 'channel_post', 'edited_channel_post'],
      drop_pending_updates: false,
      timeout: 30,
      onStart: info => {
        pollingStarted = true;
        console.log(`FinTrack @${info.username} is running with SQLite storage and long polling.`);
        if (stopping) void bot.stop();
      },
    });
  } finally {
    stopping = true;
    if (timer) clearInterval(timer);
    if (tickRunning) await tickRunning;
    await tasks.drain();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

function safeError(error: unknown): string {
  // Standard errors may carry a Telegram URL; never log the raw request/config.
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.replace(/\b\d+:[A-Za-z0-9_-]{20,}\b/g, '[redacted token]');
}

main().catch(error => {
  console.error('FinTrack stopped:', safeError(error));
  process.exitCode = 1;
});
