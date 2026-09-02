#!/usr/bin/env node
/**
 * Register, inspect or remove the Telegram webhook.
 *
 *   BOT_TOKEN=... WORKER_URL=https://fintrack.<sub>.workers.dev \
 *   WEBHOOK_SECRET=... node scripts/webhook.mjs set
 */
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { BOT_TOKEN, WORKER_URL, WEBHOOK_SECRET } = process.env;
const action = process.argv[2] ?? 'info';

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required (put it in .env or the environment).');
  process.exit(1);
}

const api = async (method, body) => {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
};

const COMMANDS = [
  ['month', 'This month by category'],
  ['stats', 'Last 6 months'],
  ['last', 'Recent expenses'],
  ['cats', 'Manage categories'],
  ['budget', 'Monthly limits'],
  ['export', 'PDF or CSV report'],
  ['undo', 'Remove the last expense'],
  ['tz', 'Set your timezone'],
  ['help', 'How to use the bot'],
].map(([command, description]) => ({ command, description }));

switch (action) {
  case 'set': {
    if (!WORKER_URL || !WEBHOOK_SECRET) {
      console.error('WORKER_URL and WEBHOOK_SECRET are required for "set".');
      process.exit(1);
    }
    await api('setWebhook', {
      url: `${WORKER_URL.replace(/\/$/, '')}/telegram/webhook`,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
      max_connections: 40,
    });
    await api('setMyCommands', { commands: COMMANDS });
    console.log('Webhook set and command menu published.');
    break;
  }
  case 'delete':
    await api('deleteWebhook', { drop_pending_updates: false });
    console.log('Webhook removed.');
    break;
  case 'info':
    console.log(await api('getWebhookInfo'));
    break;
  default:
    console.error(`Unknown action "${action}". Use set | info | delete.`);
    process.exit(1);
}
