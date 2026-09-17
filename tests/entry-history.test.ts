import { describe,it,expect } from 'vitest';
import { fixture,day } from './bot-fixture';

describe('editing entries from all recorded history',()=>{
 it('opens /edit without IDs and pages beyond recent lists into old records',async()=>{
  const h=await fixture();const old=await h.db.addTransaction(1,null,1,'Old coffee','2022-06-05',1);
  for(let i=0;i<25;i++)await h.db.addTransaction(1,null,1,'Recent '+i,day,1);
  await h.db.addTransaction(2,null,1,'Private coffee','2022-06-05',3);
  await h.command('/edit');expect(h.calls.at(-1)!.payload.rich_message.blocks[0].text).toContain('Find an entry');
  for(let i=0;i<3;i++)await h.click('Older');
  expect(h.buttons().some(b=>b.callback_data===`correct:expense:${old}:review`)).toBe(true);
  expect(JSON.stringify(h.calls.at(-1))).not.toContain('Private coffee');
  await h.tap(`correct:expense:${old}:review`);await h.click('Edit name');await h.command('Breakfast');
  await h.click('Change date');await h.command('2022-06-06');await h.click('Edit amount');await h.command('2');
  await h.click('Save correction');expect(await h.db.transaction(1,old)).toMatchObject({note:'Breakfast',spent_on:'2022-06-06',amount:2});
  expect(h.buttons().some(b=>b.text==='Edit entry')).toBe(true);
 });
 it('searches literal names and dates, filters kinds, and does not turn search text into spending',async()=>{
  const h=await fixture();await h.db.addTransaction(1,null,1,'Coffee 100%','2022-06-05',1);
  await h.db.income.add(1,'Coffee refund',100,'2022-06-07','refund',1);
  await h.command('/history 2022-06');expect(h.buttons().filter(b=>b.callback_data.startsWith('correct:'))).toHaveLength(2);
  await h.click('Income');expect(h.buttons().filter(b=>b.callback_data.startsWith('correct:'))).toHaveLength(1);
  await h.click('All entries');await h.click('Search item or date');await h.command('100%');
  expect(h.buttons().filter(b=>b.callback_data.startsWith('correct:'))).toHaveLength(1);
  expect(await h.db.totalBetween(1,'2000-01-01',day)).toBe(1);
  await h.command('/edit Coffee');expect(h.buttons().filter(b=>b.callback_data.startsWith('correct:'))).toHaveLength(2);
  await h.command('/edit missing');expect(JSON.stringify(h.calls.at(-1))).toContain('No matching entries');
 });
 it('rejects stale paging buttons without replacing a correction and keeps ownership checks',async()=>{
  const h=await fixture(),id=await h.db.addTransaction(1,null,10,'Coffee',day,1);
  await h.command('/edit');const search=h.buttons().find(b=>b.text==='Search item or date')!.callback_data;
  await h.tap(`correct:expense:${id}:review`);const request=(await h.draft()).request;
  await h.tap(search);expect((await h.draft()).request).toBe(request);expect(h.calls.at(-1)!.payload.text).toContain('expired');
  await h.command(`/edit expense ${id}`,2);expect(await h.db.getState(2)).toBeNull();
 });
 it('renames channel items, preserves category, and supports category-only corrections without a Telegram edit',async()=>{
  const h=await fixture(true),categories=await h.db.categories(1),category=categories[0]!,other=categories[1]!;
  await h.command('/add Coffee');await h.action('account:1');await h.command('100');await h.action('cat:'+category.id);await h.click('Save entry');
  let tx=(await h.db.recentTransactions(1,1))[0]!;
  await h.command('/edit Coffee');await h.tap(`correct:expense:${tx.id}:review`);await h.click('Edit name');await h.command('Morning coffee');
  await h.click('Save correction');tx=(await h.db.recentTransactions(1,1))[0]!;expect(tx).toMatchObject({note:'Morning coffee',category_id:category.id,amount:100});
  expect(JSON.stringify(h.calls.filter(c=>c.payload.chat_id===-1001).at(-1))).toContain('Morning coffee');
  const edits=h.calls.filter(c=>c.payload.chat_id===-1001).length;
  await h.tap(`correct:expense:${tx.id}:review`);await h.click('Change category');await h.action('cat:'+other.id);await h.click('Save correction');
  expect(h.calls.filter(c=>c.payload.chat_id===-1001)).toHaveLength(edits);
  expect((await h.db.transaction(1,tx.id))!.category_id).toBe(other.id);
  expect((await h.db.finance.aliases(1)).find(a=>a.label==='Morning coffee')!.category_id).toBe(other.id);
 });
});
