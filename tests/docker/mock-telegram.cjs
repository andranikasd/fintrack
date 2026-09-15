// Container smoke test only. Replaces node-fetch before grammY is imported.
// Every Telegram call stays in-process; no real token/account is contacted.
const { createRequire } = require('node:module');
const requireApp = createRequire('/app/package.json');
const { existsSync, writeFileSync } = require('node:fs');
const native = requireApp('node-fetch');
const now = Math.floor(Date.now() / 1000);
const user = { id: 123456789, is_bot: false, first_name: 'Smoke' };
const chat = { id: user.id, type: 'private', first_name: 'Smoke' };
const channel = { id: -1001234567890, type: 'channel', title: 'Smoke expenses' };
const message = (id, text) => ({ update_id: id, message: { message_id: id, date: now, chat, from: user, text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } });
const updates = [
  message(1, '/start'),
  message(2, '/goal laptop | 960,381.77 | daily:3000 | 0'),
  message(3, '/linkchannel -1001234567890'),
  { update_id: 4, channel_post: { message_id: 1, date: now, chat: channel, rich_message: { blocks: [{ type: 'table', cells: [['Item', 'price'], ['metro', '150'], ['redline', '600']].map(row => row.map(text => ({ text, align: 'center', valign: 'middle' }))) }] } } },
  message(5, '/save laptop 5500'),
  message(6, '/chartpdf 7'),
  message(7, '/income salary 450000'),
  message(8, '/dashboard'),
];
const fake = async (url, options = {}) => {
  if (!String(url).startsWith('https://api.telegram.org/')) throw new Error('Unexpected network request in smoke test');
  const method = String(url).split('/').pop();
  let result = true;
  if (method === 'getMe') result = { id: 999, is_bot: true, first_name: 'Smoke bot', username: 'fintrack_smoke_bot' };
  if (method === 'getChat') result = channel;
  if (method === 'getChatMember') result = { status: 'administrator', user };
  if (method === 'sendDocument') {
    let size = 0;
    for await (const part of options.body) size += Buffer.byteLength(part);
    writeFileSync('/data/smoke-pdf-size', String(size));
    result = { message_id: 99, date: now, chat };
  }
  if (method === 'sendMessage') {
    const payload = JSON.parse(options.body);
    const link = payload.reply_markup?.inline_keyboard?.flat().find(b => b.url)?.url;
    if (link) writeFileSync('/data/smoke-dashboard-link', link);
  }
  if (method === 'sendMessage') result = { message_id: 100, date: now, chat };
  if (method === 'getUpdates') {
    if (!existsSync('/data/smoke-delivered')) {
      writeFileSync('/data/smoke-delivered', '1');
      result = updates;
    } else {
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 250);
        options.signal?.addEventListener('abort', finish, { once: true });
        if (options.signal?.aborted) finish();
      });
      result = [];
    }
  }
  return new native.Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
};
fake.default = fake;
requireApp.cache[requireApp.resolve('node-fetch')].exports = fake;
