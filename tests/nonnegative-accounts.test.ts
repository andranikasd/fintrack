import { describe, expect, it } from 'vitest';
import { testDb } from './sqlite';

async function fixture() {
  const { db, d1 } = testDb();
  await db.ensureUser(1);
  await db.accounts.create(1, 'Card', 10000, '2026-01-01', 'card');
  await db.accounts.create(1, 'Cash', 0, '2026-01-01', 'cash');
  await db.finance.putGoal(1, 'Laptop', 100000, null, 100, 0, null);
  return { db, d1, goal: (await db.finance.goals(1))[0]!, balance: async () => (await db.accounts.list(1, '2026-12-31')).find(a => a.name === 'Card')!.balance_minor };
}

describe('nonnegative account balances', () => {
  it('allows exactly zero, rejects another debit and keeps retries idempotent', async () => {
    const { db, balance } = await fixture();
    await db.addTransaction(1, null, 100, 'coffee', '2026-01-01', 1, 'coffee');
    await db.addTransaction(1, null, 100, 'coffee', '2026-01-01', 1, 'coffee');
    await expect(db.addTransaction(1, null, 1, 'extra', '2026-01-01', 1)).rejects.toThrow('Insufficient funds');
    expect(await balance()).toBe(0);
    expect(await db.totalBetween(1, '2026-01-01', '2026-12-31')).toBe(100);
  });
  it('rejects backdated spending even if later income makes the current balance sufficient', async () => {
    const { db, balance } = await fixture();
    await db.income.add(1, 'Pay', 10000, '2026-01-03', 'pay', 1);
    await expect(db.addTransaction(1, null, 101, 'early', '2026-01-02', 1)).rejects.toThrow('Insufficient funds');
    expect(await balance()).toBe(20000);
  });
  it('checks later balances when adding an earlier debit, including the Telegram preflight', async () => {
    const { db, balance } = await fixture();
    await db.addTransaction(1, null, 100, 'later', '2026-01-03', 1);
    await expect(db.accounts.assertCanSpend(1, 1, 100, '2026-01-02')).rejects.toThrow('Insufficient funds');
    await expect(db.addTransaction(1, null, 1, 'early', '2026-01-02', 1)).rejects.toThrow('Insufficient funds');
    expect(await balance()).toBe(0);
  });
  it('rejects income deletion, reduced opening balances and transfers to an unfunded account', async () => {
    const { db, d1, balance } = await fixture();
    await db.income.add(1, 'Pay', 10000, '2026-01-01', 'pay', 1);
    const tx = await db.addTransaction(1, null, 200, 'purchase', '2026-01-02', 1);
    const income = (await db.income.list(1, '2026-01-01', '2026-01-31'))[0]!;
    await expect(db.income.remove(1, income.id)).rejects.toThrow('Insufficient funds');
    await expect(d1.prepare('UPDATE accounts SET opening_minor=9999 WHERE id=1').run()).rejects.toThrow('Insufficient funds');
    await expect(d1.prepare('UPDATE transactions SET account_id=2 WHERE id=?').bind(tx).run()).rejects.toThrow('Insufficient funds');
    await expect(d1.prepare("UPDATE income SET received_on='2026-01-03' WHERE id=?").bind(income.id).run()).rejects.toThrow('Insufficient funds');
    expect(await balance()).toBe(0);
  });
  it('protects exact savings debits and deletion of a spent withdrawal', async () => {
    const { db, d1, goal, balance } = await fixture();
    await db.finance.contribute(1, goal.id, 9999, '2026-01-01', 'save', 1);
    await expect(db.finance.contribute(1, goal.id, 2, '2026-01-01', 'too-much', 1)).rejects.toThrow('Insufficient funds');
    await db.finance.contribute(1, goal.id, -9999, '2026-01-02', 'withdraw', 1);
    await db.addTransaction(1, null, 100, 'purchase', '2026-01-02', 1);
    await expect(d1.prepare("DELETE FROM savings WHERE event_key='withdraw'").run()).rejects.toThrow('Insufficient funds');
    expect(await balance()).toBe(0);
  });
  it('validates channel replacements as a whole regardless of row order and rolls back rejected edits', async () => {
    const { db, d1, balance } = await fixture();
    const rows = [{categoryId:null,label:'purchase',amount:200,accountId:1}, {categoryId:null,label:'Pay',amount:10000,income:true,accountId:1}];
    await db.finance.syncPost(1, -1001, 1, 1, 1, '2026-01-01', rows, null);
    await db.finance.syncPost(1, -1001, 1, 2, 2, '2026-01-01', rows, null);
    await expect(db.finance.syncPost(1, -1001, 1, 3, 3, '2026-01-01', rows.slice(0, 1), null)).rejects.toThrow('Insufficient funds');
    expect(await balance()).toBe(0);
    expect(await db.income.total(1, '2026-01-01', '2026-01-01')).toBe(10000);
    expect(await d1.prepare('SELECT count(*) FROM account_balance_batches').first('count(*)')).toBe(0);
    expect(await d1.prepare('SELECT count(*) FROM account_balance_dirty').first('count(*)')).toBe(0);
  });
  it('serializes competing spends and rejects negative opening balances', async () => {
    const { db, balance } = await fixture();
    const results = await Promise.allSettled([1, 2].map(i => db.addTransaction(1, null, 60, 'purchase', '2026-01-01', 1, 'race'+i)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balance()).toBe(4000);
    await expect(db.accounts.create(1, 'Negative', -1, '2026-01-01', 'negative')).rejects.toThrow(/negative/);
  });
});
