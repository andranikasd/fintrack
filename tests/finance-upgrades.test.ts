import { describe, expect, it } from 'vitest';
import { fixture, day, tz } from './bot-fixture';
import { nextBillDate } from '../src/bills-db';
import { dashboardData } from '../src/web/data';
import { collectReport } from '../src/handlers/export';
import { runFinanceSchedule } from '../src/scheduled-finance';
import { addDays } from '../src/lib/dates';
import { changeChannelEntry } from '../src/lib/channel-table';
import { parseDailyPost } from '../src/lib/daily-post';

const billInput={label:'Internet',amount_minor:10000,account_id:1,category_id:null,frequency:'monthly' as const,next_due:day,remind_time:'09:00',enabled:1};
const balances=async(h:Awaited<ReturnType<typeof fixture>>)=>Object.fromEntries((await h.db.accounts.list(1,day)).map(a=>[a.name,a.balance_minor]));

describe('account transfers',()=>{
  it('moves exact amounts once, reports both sides and leaves income/spending unchanged',async()=>{
    const h=await fixture();
    const id=await h.db.transfers.add(1,1,2,10077,day,'Cash withdrawal','transfer:1',day);
    expect(await h.db.transfers.add(1,1,2,10077,day,'Cash withdrawal','transfer:1',day)).toBe(id);
    expect(await balances(h)).toEqual({Card:89923,Cash:60077});
    expect(await h.db.totalBetween(1,day,day)).toBe(0);
    expect(await h.db.income.total(1,day,day)).toBe(0);
    const data=await dashboardData(h.db,1,tz,day,day);
    expect(data.records).toHaveLength(0);expect(data.transfers).toHaveLength(1);
    const report=await collectReport(h.db,1,day,day,'Today',null,'AMD',day);
    expect(report.finance!.transfers![0]).toMatchObject({from_name:'Card',to_name:'Cash',amount_minor:10077});
    expect(await h.db.transfers.remove(2,id)).toBe(false);
    expect(await h.db.transfers.remove(1,id)).toBe(true);
    expect(await balances(h)).toEqual({Card:100000,Cash:50000});
  });
  it('rejects overdrafts, foreign accounts and historical deficits atomically',async()=>{
    const h=await fixture();
    await expect(h.db.transfers.add(1,1,2,100001,day,'','over',day)).rejects.toThrow('Insufficient funds');
    await expect(h.db.transfers.add(1,1,3,100,day,'','foreign',day)).rejects.toThrow('owned');
    await expect(h.db.transfers.add(1,1,1,100,day,'','same',day)).rejects.toThrow('different');
    await expect(h.db.transfers.add(1,1,2,100,addDays(day,1),'','future',day)).rejects.toThrow('past');
    await h.db.addTransaction(1,null,900,'Past purchase',addDays(day,-1),1);
    await h.db.income.add(1,'Today income',100000,day,'income',1);
    await expect(h.db.transfers.add(1,1,2,20000,addDays(day,-2),'','backdated',day)).rejects.toThrow('Insufficient funds');
    expect(await balances(h)).toEqual({Card:110000,Cash:50000});
    expect(await h.db.transfers.list(1)).toHaveLength(0);
  });
  it('refuses undo after the destination spent the transferred money',async()=>{
    const h=await fixture(),id=await h.db.transfers.add(1,1,2,10000,day,'','move',day);
    await h.db.addTransaction(1,null,600,'Spent all cash',day,2);
    await expect(h.db.transfers.remove(1,id)).rejects.toThrow('Insufficient funds');
    expect(await balances(h)).toEqual({Card:90000,Cash:0});
    expect(await h.db.transfers.list(1)).toHaveLength(1);
  });
});

describe('recurring bills',()=>{
  it('keeps the monthly anchor across short months and leap years',()=>{
    expect(nextBillDate('2026-01-31','monthly',31)).toBe('2026-02-28');
    expect(nextBillDate('2026-02-28','monthly',31)).toBe('2026-03-31');
    expect(nextBillDate('2028-01-31','monthly',31)).toBe('2028-02-29');
    expect(nextBillDate('2026-12-31','monthly',31)).toBe('2027-01-31');
    expect(nextBillDate('2026-12-28','weekly',28)).toBe('2027-01-04');
  });
  it('reminds in local time, deduplicates delivery and records only on confirmation',async()=>{
    const h=await fixture(),id=await h.db.bills.save(1,billInput,'rule');
    await runFinanceSchedule(h.db,h.bot.api,{id:1,tz},'֏',new Date(day+'T04:59:00Z'));
    expect(h.calls.filter(c=>c.payload.text?.includes('Internet'))).toHaveLength(0);
    for(let i=0;i<2;i++)await runFinanceSchedule(h.db,h.bot.api,{id:1,tz},'֏',new Date(day+'T05:00:00Z'));
    expect(h.calls.filter(c=>c.payload.text?.includes('Internet'))).toHaveLength(1);
    expect(await h.db.totalBetween(1,day,day)).toBe(0);
    const [o]=await h.db.bills.due(1,day,'09:00');
    await h.tap(`bill:paid:${o!.id}`,2);expect(await h.db.totalBetween(1,day,day)).toBe(0);
    await h.tap(`bill:paid:${o!.id}`);await h.tap(`bill:paid:${o!.id}`);
    expect(await h.db.totalBetween(1,day,day)).toBe(100);
    expect((await h.db.bills.get(1,id))!.next_due).toBe(nextBillDate(day,'monthly',Number(day.slice(8))));
    expect((await h.db.bills.occurrence(1,o!.id))!.status).toBe('paid');
  });
  it('links an already recorded expense without duplicating it, or explicitly records another',async()=>{
    const h=await fixture();await h.db.bills.save(1,billInput,'rule');
    const expense=await h.db.addTransaction(1,null,100,'Internet',day,1);
    const [o]=await h.db.bills.due(1,day,'12:00');
    await h.tap(`bill:paid:${o!.id}`);
    expect(h.buttons().some(b=>b.text.startsWith('Already recorded'))).toBe(true);
    await h.click(`Already recorded: #${expense}`);
    expect(await h.db.totalBetween(1,day,day)).toBe(100);
    expect((await h.db.bills.occurrence(1,o!.id))!.transaction_id).toBe(expense);
    await h.db.bills.save(1,billInput,'second-rule');const [other]=await h.db.bills.due(1,day,'12:00');
    await h.tap(`bill:paid:${other!.id}`);await h.click('Record another payment');
    expect(await h.db.totalBetween(1,day,day)).toBe(200);
  });
  it('retains unpaid reminders on insufficient funds and invalidates edited reminders',async()=>{
    const h=await fixture(),id=await h.db.bills.save(1,{...billInput,amount_minor:200000},'rule');
    const [o]=await h.db.bills.due(1,day,'12:00');
    await expect(h.db.bills.resolve(1,o!.id,day,'paid')).rejects.toThrow('Insufficient funds');
    expect((await h.db.bills.occurrence(1,o!.id))!.status).toBe('pending');
    expect((await h.db.bills.get(1,id))!.next_due).toBe(day);
    await h.db.bills.save(1,{...billInput,enabled:0},'edit',id,1);
    expect(await h.db.bills.resolve(1,o!.id,day,'paid')).toBeNull();
    expect(await h.db.bills.due(1,day,'12:00')).toHaveLength(0);
    await expect(h.db.bills.save(1,billInput,'stale',id,1)).rejects.toThrow('changed');
    expect(await h.db.totalBetween(1,day,day)).toBe(0);
  });
  it('requires skip confirmation and advances without recording an expense',async()=>{
    const h=await fixture();await h.db.bills.save(1,{...billInput,frequency:'weekly'},'rule');
    const [o]=await h.db.bills.due(1,day,'12:00');await h.tap(`bill:skip:${o!.id}`);
    expect((await h.db.bills.occurrence(1,o!.id))!.status).toBe('pending');
    await h.click('Skip this payment');
    expect((await h.db.bills.list(1))[0]!.next_due).toBe(addDays(day,7));
    expect(await h.db.totalBetween(1,day,day)).toBe(0);
  });
});

describe('guided setup and retained drafts',()=>{
  it('creates and edits an account using buttons and rejects stale edits',async()=>{
    const h=await fixture();await h.command('/account');await h.command('Wallet');
    await h.click('Clear');await h.click('2');await h.click('0');await h.click('Use amount');await h.click('Today');await h.click('No');await h.click('Save account');
    const a=(await h.db.accounts.list(1,day)).find(a=>a.name==='Wallet')!;expect(a.opening_minor).toBe(2000);
    await h.command('/accounts');await h.click('Edit Wallet');await h.click('Opening balance');await h.command('30.77');await h.click('Save account');
    expect((await h.db.accounts.get(1,a.id))!.opening_minor).toBe(3077);
    await h.tap(`setup:account:${a.id}`);await h.click('Opening balance');await h.command('40');
    await h.d1.prepare('UPDATE accounts SET name=?,version=version+1 WHERE id=?').bind('Wallet renamed',a.id).run();
    await h.click('Save account');expect((await h.db.accounts.get(1,a.id))!.opening_minor).toBe(3077);
  });
  it('creates a goal, edits its plan and preserves existing contributions',async()=>{
    const h=await fixture();await h.command('/goal');await h.command('Holiday');await h.command('1000');await h.click('Daily amount');await h.command('10.77');await h.click('Use amount');await h.click('Skip');await h.click('Save savings goal');
    let g=(await h.db.finance.goals(1))[0]!;expect(g).toMatchObject({name:'Holiday',daily_minor:1077,opening_minor:0});
    await h.db.finance.contribute(1,g.id,10000,day,'contribution',1);
    await h.tap(`setup:goal:${g.id}`);await h.click('Target amount');await h.command('2000');await h.click('Save savings goal');
    g=(await h.db.finance.goals(1))[0]!;expect(g).toMatchObject({target_minor:200000,saved_minor:10000});
    await h.tap('setup:goal:new');await h.command('Holiday');await h.command('9999');await h.click('Daily amount');await h.command('1');await h.click('Use amount');await h.click('Skip');await h.click('Save savings goal');
    expect((await h.db.finance.goals(1))[0]!.target_minor).toBe(200000);
    expect((await h.draft()).kind).toBe('goal');
  });
  it('pauses an expense for reports and setup, restores all fields, and isolates users',async()=>{
    const h=await fixture();await h.command('/add');await h.command('Coffee');await h.action('account:1');await h.command('150');await h.click('Categorize later');
    const original=await h.draft(),request=original.request.replaceAll('-','');
    await h.command('/accounts');expect(await h.db.getState(1)).toBeNull();
    expect(await h.db.drafts(1)).toHaveLength(1);
    await h.tap(`resume:${request}`,2);expect(await h.db.getState(2)).toBeNull();
    await h.command('/account');await h.command('New wallet');const accountDraft=await h.draft();
    await h.tap(`resume:${request}`);expect(await h.draft()).toMatchObject(original);
    expect((await h.db.drafts(1))[0]!.request).toBe(accountDraft.request.replaceAll('-',''));
    await h.click('Save entry');expect(await h.db.totalBetween(1,day,day)).toBe(150);
    await h.command('/resume');await h.click('Continue New wallet');expect((await h.draft()).values.label).toBe('New wallet');
  });
  it('guides transfers and bills without command arguments',async()=>{
    const h=await fixture();await h.command('/transfer');await h.click('Card · 1,000 ֏');await h.click('Cash · 500 ֏');await h.command('100.77');await h.click('Today');await h.click('Skip');await h.click('Record transfer');
    expect(await balances(h)).toEqual({Card:89923,Cash:60077});
    await h.command('/bill');await h.command('Internet');await h.command('100');await h.click('Card · 899.23 ֏');await h.click('Skip');await h.click('Every month');await h.click('Today');await h.click('09:00');await h.click('Save recurring bill');
    expect((await h.db.bills.list(1))[0]).toMatchObject(billInput);
  });
});

describe('duplicate protection and savings corrections',()=>{
  it('warns for a matching entry and requires a fresh acknowledgement after changes',async()=>{
    const h=await fixture();await h.db.addTransaction(1,null,100,'Coffee',day,1);
    await h.command('/add Coffee');await h.action('account:1');await h.command('100');await h.click('Categorize later');await h.click('Save entry');
    expect(await h.db.totalBetween(1,day,day)).toBe(100);const old=h.buttons().find(b=>b.text==='Save anyway')!.callback_data;
    await h.click('Change account');await h.action('account:2');await h.tap(old);
    expect(await h.db.totalBetween(1,day,day)).toBe(100);
    await h.click('Save anyway');expect(await h.db.totalBetween(1,day,day)).toBe(200);
    await h.tap(old);expect(await h.db.totalBetween(1,day,day)).toBe(200);
  });
  it('edits savings, rejects removing consumed savings, and safely undoes withdrawals',async()=>{
    const h=await fixture();await h.db.finance.putGoal(1,'Laptop',1000000,null,1000,0,null);const g=(await h.db.finance.goals(1))[0]!;
    await h.db.finance.contribute(1,g.id,20000,day,'save',1);
    const saved=(await h.db.finance.savingsEntries(1,day,day))[0]!;
    await h.tap(`correct:saving:${saved.id}:amount`);await h.command('250.77');await h.click('Save correction');expect((await h.db.finance.goals(1))[0]!.saved_minor).toBe(25077);
    await h.db.finance.contribute(1,g.id,-20000,day,'withdraw',2);
    await h.tap(`correct:saving:${saved.id}:undo`);await h.click('Undo entry');expect((await h.db.finance.goals(1))[0]!.saved_minor).toBe(5077);
    const withdrawal=(await h.db.finance.savingsEntries(1,day,day)).find(r=>r.amount_minor<0)!;
    await h.tap(`correct:withdrawal:${withdrawal.id}:undo`);await h.click('Undo entry');expect((await h.db.finance.goals(1))[0]!.saved_minor).toBe(25077);
    await h.tap(`correct:saving:${saved.id}:account`);await h.action('account:2');await h.click('Save correction');
    expect((await h.db.finance.savingsEntries(1,day,day))[0]!.account_id).toBe(2);
  });
  it('preserves other row types and expense totals when correcting imported income or savings',()=>{
    const date=Date.parse('2026-09-15T08:00:00Z')/1000;
    const source={date,text:'Sep 15\nItem | price\nCoffee @ Card | 100\nincome:Salary @ Card | 1000.77\nsave:Laptop @ Card | 50.77\nwithdraw:Laptop @ Cash | 20.77\nTotal: 100'};
    for(const [kind,label]of [['income','income:Salary'],['save','save:Laptop'],['withdraw','withdraw:Laptop']] as const){
      const edit=changeChannelEntry(source,tz,kind,0,{label:label+' @ Cash',amount:30.77});
      expect(edit.text).toContain('Coffee @ Card | 100');expect(edit.text).toContain('Total: 100');
      expect(parseDailyPost({date,text:edit.text},tz).rows.find(r=>r.kind===kind)!.amountMinor).toBe(3077);
      const removed=changeChannelEntry(source,tz,kind,0,null);expect(parseDailyPost({date,text:removed.text},tz).rows).toHaveLength(3);
    }
  });
});

describe('channel correction coverage',()=>{
  it('edits and undoes income, deposits and withdrawals in the original source',async()=>{
    const h=await fixture(true);await h.db.finance.putGoal(1,'Laptop',1000000,null,1000,0,null);
    const date=Math.floor(Date.now()/1000)-60;
    await h.bot.handleUpdate({update_id:1,channel_post:{message_id:77,date,chat:{id:-1001,type:'channel',title:'Diary'},text:'Item | price\nCoffee @ Card | 100\nincome:Salary @ Card [passive] | 1000.77\nsave:Laptop @ Card | 200.77\nwithdraw:Laptop @ Cash | 50.22\nTotal: 100'}});
    expect((await h.db.finance.post(-1001,77))!.error).toBeNull();
    const id=async(kind:string)=>kind==='income'?(await h.db.income.list(1,day,day))[0]!.id:(await h.db.finance.savingsEntries(1,day,day)).find(r=>(r.amount_minor>0)===(kind==='saving'))!.id;
    for(const kind of ['income','saving','withdrawal']){
      await h.tap(`correct:${kind}:${await id(kind)}:amount`);await h.command(kind==='income'?'1100.77':kind==='saving'?'220.77':'60.22');await h.click('Save correction');
      expect(await h.db.getState(1)).toBeNull();expect((await h.db.finance.post(-1001,77))!.error).toBeNull();
      await h.tap(`correct:${kind}:${await id(kind)}:account`);await h.action('account:2');await h.click('Save correction');expect(await h.db.getState(1)).toBeNull();
    }
    expect((await h.db.income.list(1,day,day))[0]).toMatchObject({amount_minor:110077,account_id:2,passive:1});
    expect((await h.db.finance.goals(1))[0]!.saved_minor).toBe(16055);
    expect(await h.db.totalBetween(1,day,day)).toBe(100);
    for(const kind of ['withdrawal','saving','income']){await h.tap(`correct:${kind}:${await id(kind)}:undo`);await h.click('Undo entry');}
    expect(await h.db.income.list(1,day,day)).toHaveLength(0);
    expect(await h.db.finance.savingsEntries(1,day,day)).toHaveLength(0);
    expect(await h.db.totalBetween(1,day,day)).toBe(100);
    const edits=h.calls.filter(c=>c.method==='editMessageText'&&c.payload.chat_id===-1001);
    expect(edits.at(-1)!.payload.text).toContain('Total: 100');
  });
  it('refuses removing consumed channel income before changing Telegram',async()=>{
    const h=await fixture(true),date=Math.floor(Date.now()/1000)-60;
    await h.bot.handleUpdate({update_id:1,channel_post:{message_id:77,date,chat:{id:-1001,type:'channel',title:'Diary'},text:'Item | price\nincome:Salary @ Card | 1000\nCoffee @ Card | 1900\nTotal: 1900'}});
    const income=(await h.db.income.list(1,day,day))[0]!;
    await h.tap(`correct:income:${income.id}:undo`);await h.click('Undo entry');
    expect(h.calls.filter(c=>c.method==='editMessageText'&&c.payload.chat_id===-1001)).toHaveLength(0);
    expect(await h.db.income.total(1,day,day)).toBe(100000);
    expect((await balances(h)).Card).toBe(10000);
  });
});

it('warns for quick text duplicates as well as guided entry and preserves passive income',async()=>{
  const h=await fixture();
  await h.command('100 Coffee @ Card');await h.command('100 Coffee @ Card');
  expect(await h.db.totalBetween(1,day,day)).toBe(100);await h.click('Save anyway');expect(await h.db.totalBetween(1,day,day)).toBe(200);
  await h.command('/income Interest @ Card [passive] 10.77');await h.command('/income Interest @ Card [passive] 10.77');
  expect(await h.db.income.total(1,day,day)).toBe(1077);await h.click('Save anyway');
  expect((await h.db.income.list(1,day,day)).every(r=>r.passive===1)).toBe(true);expect(await h.db.income.total(1,day,day)).toBe(2154);
  await h.db.finance.putGoal(1,'Laptop',1000000,null,1000,0,null);
  await h.command('/save Laptop 100 @ Card');await h.command('/save Laptop 100 @ Card');
  expect((await h.db.finance.goals(1))[0]!.saved_minor).toBe(10000);await h.click('Save anyway');expect((await h.db.finance.goals(1))[0]!.saved_minor).toBe(20000);
});
