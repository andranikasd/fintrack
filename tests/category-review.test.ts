import { describe, expect, it } from 'vitest';
import type { Update } from 'grammy/types';
import { createBot } from '../src/bot';
import { addDays, todayIn } from '../src/lib/dates';
import { uncategorizedKeyboard } from '../src/handlers/category-review';
import { testDb } from './sqlite';

async function setup() {
  const { db, d1 } = testDb();
  await db.ensureUser(1); await db.accounts.create(1,'Test account',100000000,'2000-01-01','test-account:1');
  const day = todayIn('Asia/Yerevan');
  const now = Math.floor(Date.now() / 1000);
  await db.finance.link(-1001, 1, 'Expenses');
  await db.finance.syncPost(1, -1001, 1, now, 1, day, [
    { categoryId: null, label: 'metro', amount: 150 },
    { categoryId: null, label: 'metro', amount: 150 },
    { categoryId: null, label: 'duet', amount: 150 },
    { categoryId: null, label: 'redline', amount: 600 },
  ], null);
  const bot = createBot({
    DB: d1, BOT_TOKEN: 'test', BOT_INFO: JSON.stringify({ id: 99, is_bot: true, first_name: 'Test', username: 'test_bot' }),
    ALLOWED_USER_IDS: '1,2', WEBHOOK_SECRET: 'test', DEFAULT_TZ: 'Asia/Yerevan', CURRENCY: 'AMD', CURRENCY_SIGN: '֏',
  }, { waitUntil: () => {} });
  const sent: Array<{ method: string; payload: Record<string, any> }> = [];
  bot.api.config.use(async (_next, method, payload) => {
    sent.push({ method, payload: payload as Record<string, any> });
    return { ok: true, result: true } as never;
  });
  let updateId = 10;
  const user = (id: number) => ({ id, is_bot: false, first_name: 'Owner' });
  const chat = (id: number) => ({ id, type: 'private' as const, first_name: 'Owner' });
  const command = async (text: string) => {
    const id = updateId++;
    await bot.handleUpdate({ update_id: id, message: { message_id: id, from: user(1), chat: chat(1), date: now, text,
      entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] : undefined,
    } });
  };
  const tap = async (data: string, owner = 1) => {
    await bot.handleUpdate({ update_id: updateId++, callback_query: {
      id: `tap-${updateId}`, from: user(owner), chat_instance: 'test', data,
      message: { message_id: 100, from: { ...user(99), is_bot: true }, chat: chat(owner), date: now, text: 'Category picker' },
    } } as Update);
  };
  return { db, bot, day, now, sent, command, tap };
}

describe('category suggestions in reports', () => {
  it('shows one categorize button per unknown label and keeps spending unchanged', async () => {
    const { db, day, sent, command } = await setup();
    await command('/today');
    const report = sent.find(r => r.method === 'sendRichMessage')!;
    const table = report.payload.rich_message.blocks.find((b:any) => b.type === 'table');
    expect(table.cells.map((r:any[]) => r.map(c=>c.text))).toContainEqual(['Spent', '1,050 ֏']);
    const buttons = report.payload.reply_markup.inline_keyboard.flat();
    expect(buttons.map((b: any) => b.text)).toEqual(['Categorize duet', 'Categorize metro', 'Categorize redline']);
    expect(await db.totalBetween(1, day, day)).toBe(1050);
  });

  it('remembers a chosen category on edits and new daily posts with different capitalization', async () => {
    const { db, bot, day, now, sent, tap } = await setup();
    const tx = (await db.uncategorized(1, day)).find(r => r.label === 'metro')!;
    const transport = (await db.categories(1)).find(c => c.name === 'Transport')!;
    await tap(`review:pick:${tx.id}`);
    expect(sent.at(-1)?.payload.text).toContain('Which category fits “metro”');
    expect(sent.at(-1)?.payload.reply_markup.inline_keyboard.flat().some((b: any) => b.text === '➕ New category')).toBe(true);
    await tap(`review:set:${tx.id}:${transport.id}`);
    expect((await db.byCategory(1, day, day)).find(c => c.name === 'Transport')?.total).toBe(300);
    expect(await db.finance.aliases(1)).toContainEqual({ label: 'metro', category_id: transport.id });
    await bot.handleUpdate({ update_id: 999, edited_channel_post: {
      message_id: 1, date: now, edit_date: now + 1, chat: { id: -1001, type: 'channel', title: 'Expenses' },
      text: 'Item | price\nmetro | 200\nduet | 150\nredline | 600',
    } });
    expect((await db.byCategory(1, day, day)).find(c => c.name === 'Transport')?.total).toBe(200);
    expect((await db.uncategorized(1, day)).map(r => r.label)).not.toContain('metro');
    const nextDay = addDays(day, -1);
    await bot.handleUpdate({ update_id: 1000, channel_post: {
      message_id: 2, date: now - 86400, chat: { id: -1001, type: 'channel', title: 'Expenses' },
      text: `${nextDay}\nItem | price\nMETRO | 150`,
    } });
    expect((await db.byCategory(1, nextDay, nextDay)).find(c => c.name === 'Transport')?.total).toBe(150);
    expect(await db.uncategorized(1, nextDay)).toEqual([]);
  });

  it('creates a new category and applies it without recording the name as an expense', async () => {
    const { db, day, command, tap } = await setup();
    const tx = (await db.uncategorized(1, day)).find(r => r.label === 'duet')!;
    await tap(`review:new:${tx.id}`);
    expect((await db.getState(1))?.state).toBe('review_new_category');
    await command('🥐 Bakery');
    const category = (await db.categories(1)).find(c => c.name === 'Bakery')!;
    expect(category).toBeDefined();
    expect((await db.transaction(1, tx.id))?.category_id).toBe(category.id);
    expect(await db.getState(1)).toBeNull();
    expect(await db.totalBetween(1, day, day)).toBe(1050);
  });

  it('reuses a category when the submitted name already exists and supports cancellation', async () => {
    const { db, day, command, tap } = await setup();
    const rows = await db.uncategorized(1, day);
    await tap(`review:new:${rows[0]!.id}`);
    await command('/cancel');
    expect(await db.getState(1)).toBeNull();
    expect((await db.transaction(1, rows[0]!.id))?.category_id).toBeNull();
    const count = (await db.categories(1)).length;
    await tap(`review:new:${rows[0]!.id}`);
    await command('Food');
    expect((await db.categories(1)).length).toBe(count);
    expect((await db.transaction(1, rows[0]!.id))?.category_name).toBe('Food');
  });

  it('rejects foreign, archived and stale selections', async () => {
    const { db, day, now, tap, sent } = await setup();
    const tx = (await db.uncategorized(1, day))[0]!;
    const category = (await db.categories(1))[0]!;
    await tap(`review:set:${tx.id}:${category.id}`, 2);
    expect((await db.transaction(1, tx.id))?.category_id).toBeNull();
    await db.setArchived(1, category.id, true);
    await tap(`review:set:${tx.id}:${category.id}`);
    expect((await db.transaction(1, tx.id))?.category_id).toBeNull();
    await db.finance.syncPost(1, -1001, 1, now + 1, 500, day, [], null);
    await tap(`review:pick:${tx.id}`);
    expect(sent.at(-1)?.payload.show_alert).toBe(true);
    expect(await db.finance.aliases(1)).toEqual([]);
  });

  it('paginates large lists and offers nothing once all items are categorized', async () => {
    const { db, day } = await setup();
    for (let i = 0; i < 12; i++) await db.addTransaction(1, null, 10, `item ${i}`, day);
    const first = await uncategorizedKeyboard(db, 1, day);
    expect(first?.inline_keyboard.flat().some(b => 'callback_data' in b && b.callback_data === `review:page:${day}:10`)).toBe(true);
    const second = await uncategorizedKeyboard(db, 1, day, 10);
    expect(second?.inline_keyboard.flat().filter(b => b.text.startsWith('Categorize'))).toHaveLength(5);
    expect(await uncategorizedKeyboard(db, 1, '2000-01-01')).toBeUndefined();
  });
});
