import { describe, expect, it } from 'vitest';
import { fixture, day } from './bot-fixture';

describe('guided Telegram entry',()=>{
  it('selects a recent item, suggests its account, accepts keypad input and saves only after review',async()=>{
    const h=await fixture(),category=(await h.db.categories(1))[0]!;
    await h.db.addTransaction(1,category.id,20,'Coffee',day,2);
    await h.command('/add');await h.click('Coffee');
    expect(h.buttons()[0]!.text).toContain('Suggested: Cash');
    await h.action('account:2');
    for(const digit of ['1','5','0'])await h.click(digit);
    await h.click('Use amount');
    expect((await h.draft()).step).toBe('review');
    expect(await h.db.totalBetween(1,day,day)).toBe(20);
    const save=h.buttons().find(b=>b.text==='Save entry')!.callback_data;
    await h.tap(save);await h.tap(save);
    expect(await h.db.totalBetween(1,day,day)).toBe(170);
    expect(await h.db.getState(1)).toBeNull();
    expect(h.calls.some(c=>c.method==='sendRichMessage'&&c.payload.rich_message.blocks.some((b:any)=>b.type==='table'))).toBe(true);
  });
  it('keeps an unfunded draft and allows an amount correction without losing the item or account',async()=>{
    const h=await fixture();await h.command('/add');await h.command('Coffee');await h.action('account:1');await h.command('40000000');
    expect((await h.draft()).step).toBe('category');await h.click('Categorize later');await h.click('Save entry');
    expect(await h.db.totalBetween(1,day,day)).toBe(0);
    expect(h.calls.at(-1)!.payload.rich_message.blocks[1].text).toContain('does not have enough money');
    const request=(await h.draft()).request;
    await h.click('Edit amount');await h.command('150');
    expect(await h.draft()).toMatchObject({request,label:'Coffee',accountId:1,amount:15000});
    await h.click('Save entry');expect(await h.db.totalBetween(1,day,day)).toBe(150);
  });
  it('cancels drafts and rejects old, foreign and invalid choices',async()=>{
    const h=await fixture();await h.command('/add');const request=(await h.draft()).request;
    await h.command('Phone');await h.action('account:3');expect((await h.draft()).accountId).toBeUndefined();
    await h.action('account:1');await h.command('0');expect((await h.draft()).amount).toBeUndefined();
    await h.command('1.50');expect((await h.draft()).amount).toBeUndefined();
    await h.click('Cancel');await h.tap(`draft:${request.replaceAll('-','')}:save`);
    expect(await h.db.totalBetween(1,day,day)).toBe(0);
  });
  it('guides income, savings and withdrawals with exact decimal amounts',async()=>{
    const h=await fixture();await h.db.finance.putGoal(1,'Laptop',1000000,null,10000,0,null);
    await h.command('/income');await h.command('Salary');await h.action('account:1');
    for(const digit of ['1','0','.','7','7'])await h.click(digit);
    await h.click('Use amount');await h.click('Save entry');
    expect(await h.db.income.total(1,day,day)).toBe(1077);
    const goal=(await h.db.finance.goals(1))[0]!;
    for(const [command,amount] of [['/save','100.77'],['/withdraw','50.22']]){
      await h.command(command!);await h.action(`goal:${goal.id}`);await h.action('account:2');await h.command(amount!);await h.click('Save entry');
    }
    expect((await h.db.finance.goals(1))[0]!.saved_minor).toBe(5055);
    expect((await h.db.accounts.get(1,2))!.id).toBe(2);
    expect((await h.db.accounts.list(1,day)).find(a=>a.id===2)!.balance_minor).toBe(44945);
    await h.command('/withdraw');await h.action(`goal:${goal.id}`);await h.action('account:2');await h.command('51');await h.click('Save entry');
    expect((await h.draft()).step).toBe('review');expect((await h.db.finance.goals(1))[0]!.saved_minor).toBe(5055);
  });
  it('corrects expenses and income, protects stale edits and requires confirmation to undo',async()=>{
    const h=await fixture();const id=await h.db.addTransaction(1,null,100,'Coffee',day,1);
    await h.tap(`correct:expense:${id}:amount`,2);expect(await h.db.getState(2)).toBeNull();
    await h.tap(`correct:expense:${id}:amount`);await h.command('200');await h.click('Save correction');
    expect((await h.db.transaction(1,id))!.amount).toBe(200);
    await h.tap(`correct:expense:${id}:account`);await h.action('account:2');await h.click('Save correction');
    expect((await h.db.transaction(1,id))!.account_id).toBe(2);
    await h.tap(`correct:expense:${id}:amount`);await h.command('250');
    await h.d1.prepare('UPDATE transactions SET note=? WHERE id=?').bind('Changed',id).run();
    await h.click('Save correction');expect((await h.db.transaction(1,id))!.amount).toBe(200);
    await h.tap(`correct:expense:${id}:undo`);expect(await h.db.transaction(1,id)).not.toBeNull();
    await h.click('Undo entry');expect(await h.db.transaction(1,id)).toBeNull();
    await h.db.income.add(1,'Bonus',20000,day,'bonus',1);
    const incomeId=await h.d1.prepare("SELECT id FROM income WHERE event_key='bonus'").first<number>('id');
    await h.tap(`correct:income:${incomeId}:amount`);await h.command('90.77');await h.click('Save correction');
    expect(await h.db.income.total(1,day,day)).toBe(9077);
  });
  it('keeps channel additions, corrections and undo synchronized with the source table',async()=>{
    const h=await fixture(true),category=(await h.db.categories(1))[0]!;
    await h.command('/add');await h.command('Coffee');await h.action('account:1');await h.command('100');await h.action(`cat:${category.id}`);await h.click('Save entry');
    let tx=(await h.db.recentTransactions(1,1))[0]!;
    expect(tx).toMatchObject({source_chat:-1001,amount:100,category_id:category.id});
    expect(await h.db.getState(1)).toBeNull();
    await h.tap(`correct:expense:${tx.id}:amount`);await h.command('150');await h.click('Save correction');
    tx=(await h.db.recentTransactions(1,1))[0]!;expect(tx.amount).toBe(150);expect(tx.category_id).toBe(category.id);
    await h.tap(`correct:expense:${tx.id}:account`);await h.action('account:2');await h.click('Save correction');
    tx=(await h.db.recentTransactions(1,1))[0]!;expect(tx.account_id).toBe(2);
    await h.tap(`correct:expense:${tx.id}:undo`);await h.click('Undo entry');
    expect(await h.db.totalBetween(1,day,day)).toBe(0);
    const edit=h.calls.filter(c=>c.method==='editMessageText'&&c.payload.chat_id===-1001).at(-1)!;
    expect(JSON.stringify(edit.payload.rich_message)).toContain('Total: 0');
  });
  it('rejects an old keep button without discarding a newer draft',async()=>{
    const h=await fixture(),id=await h.db.addTransaction(1,null,100,'Coffee',day,1);
    await h.tap(`correct:expense:${id}:undo`);const keep=h.buttons().find(b=>b.text==='Keep it')!.callback_data;
    await h.command('/add');await h.command('Lunch');const request=(await h.draft()).request;
    await h.tap(keep);expect((await h.draft()).request).toBe(request);
    expect((await h.draft()).label).toBe('Lunch');expect(await h.db.transaction(1,id)).not.toBeNull();
  });
  it('refuses income removal or correction that would make the account negative',async()=>{
    const h=await fixture();await h.db.income.add(1,'Bonus',20000,day,'bonus',1);
    await h.db.addTransaction(1,null,1100,'Purchase',day,1);
    const id=await h.d1.prepare("SELECT id FROM income WHERE event_key='bonus'").first<number>('id');
    await h.tap(`correct:income:${id}:amount`);await h.command('50');await h.click('Save correction');
    expect(await h.db.income.total(1,day,day)).toBe(20000);
    expect((await h.draft()).blocked).toBe(false);
    await h.tap(`correct:income:${id}:undo`);await h.click('Undo entry');
    expect(await h.db.income.total(1,day,day)).toBe(20000);
  });
  it('rejects reserved channel row names before writing to Telegram',async()=>{
    const h=await fixture(true);await h.command('/add');await h.command('income:Salary');await h.action('account:1');await h.command('50');await h.click('Categorize later');await h.click('Save entry');
    expect(h.calls.some(c=>c.payload.chat_id===-1001)).toBe(false);
    expect(await h.db.income.total(1,day,day)).toBe(0);expect(await h.db.totalBetween(1,day,day)).toBe(0);
    expect((await h.draft()).blocked).toBe(false);
  });
  it('starts from an item name, remembers its category, and goes Back without losing the amount',async()=>{
    const h=await fixture(),category=(await h.db.categories(1))[0]!;
    await h.db.addTransaction(1,category.id,10,'Coffee',day,2);
    await h.command('/add coffee');expect(await h.draft()).toMatchObject({step:'account',categoryId:category.id});
    await h.action('account:1');await h.command('150');await h.click('Edit amount');
    expect(h.calls.at(-1)!.payload.text).toContain('coffee · Card');
    await h.click('Back to review');expect((await h.draft()).amount).toBe(15000);
    await h.command('/add Lunch');await h.action('account:1');await h.command('100');await h.click('Back');
    expect(await h.draft()).toMatchObject({step:'amount',amount:10000,digits:'100'});
    await h.click('Back');await h.action('account:2');expect(await h.draft()).toMatchObject({step:'amount',accountId:2,digits:'100'});
    await h.click('Use amount');await h.click('Categorize later');await h.click('Save entry');
    expect((await h.db.recentTransactions(1,1))[0]).toMatchObject({amount:100,account_id:2,note:'Lunch'});
  });
  it('creates a category in the draft and saves manual name and category corrections atomically',async()=>{
    const h=await fixture();await h.command('/add Lunch');await h.action('account:1');await h.command('100');
    await h.click('New category');await h.command('Work lunches');
    const category=(await h.db.categories(1)).find(c=>c.name==='Work lunches')!;
    expect(await h.db.totalBetween(1,day,day)).toBe(0);await h.click('Save entry');
    const tx=(await h.db.recentTransactions(1,1))[0]!;expect(tx.category_id).toBe(category.id);
    await h.tap(`correct:expense:${tx.id}:review`);await h.click('Edit name');await h.command('Team lunch');
    const other=(await h.db.categories(1)).find(c=>c.id!==category.id)!;await h.action(`cat:${other.id}`);
    await h.click('Save correction');expect(await h.db.transaction(1,tx.id)).toMatchObject({note:'Team lunch',category_id:other.id,amount:100});
    await h.tap(`correct:expense:${tx.id}:review`);await h.click('Edit amount');await h.command('200');
    await h.db.setTransactionCategory(1,tx.id,category.id);await h.click('Save correction');
    expect(await h.db.transaction(1,tx.id)).toMatchObject({amount:100,category_id:category.id});
  });
  it('routes phone menu buttons without treating them as an item and escapes step context',async()=>{
    const h=await fixture();await h.command('➕ Expense');await h.command('<b>Coffee</b> & tea');await h.action('account:1');
    expect(h.calls.at(-1)!.payload.parse_mode).toBe('HTML');expect(h.calls.at(-1)!.payload.text).toContain('&lt;b&gt;Coffee&lt;/b&gt; &amp; tea');
    await h.command('💰 Income');expect(await h.draft()).toMatchObject({kind:'income',step:'label'});
    await h.command('🧾 Recent');expect(await h.db.getState(1)).toBeNull();expect(h.calls.at(-1)!.payload.text).toContain('No expenses yet');
    await h.click('Income receipts');expect(h.calls.at(-1)!.payload.rich_message.blocks[0].text).toContain('Income');
    await h.command('🏦 Accounts');expect(h.calls.at(-1)!.payload.rich_message.blocks[0].text).toBe('Your accounts');
    await h.command('📄 Export');await h.click('Interactive HTML report');expect(h.calls.at(-1)!.method).toBe('sendDocument');
  });
  it('exports a static dashboard even when a browser address is configured',async()=>{
    const h=await fixture();await h.command('/dashboard');
    expect(h.calls.some(c=>c.method==='sendDocument'&&c.payload.caption.includes('read-only snapshot'))).toBe(true);
    expect(await h.d1.prepare('SELECT COUNT(*) AS n FROM dashboard_tokens').first('n')).toBe(0);
  });
  it('ignores archived and foreign accounts when suggesting previous choices',async()=>{
    const h=await fixture();await h.db.addTransaction(2,null,10,'Coffee',day,3);
    expect(await h.db.accounts.suggest(1,'expense','Coffee')).toBeNull();
    await h.db.addTransaction(1,null,10,'Coffee',day,2);
    expect(await h.db.accounts.suggest(1,'expense','coffee')).toBe(2);
    await h.d1.prepare('UPDATE accounts SET archived=1 WHERE id=2').run();
    expect(await h.db.accounts.suggest(1,'expense','Coffee')).toBeNull();
  });
});
