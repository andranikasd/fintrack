import type { Db } from '../db';
import type { Database } from '../database';
import { validDate, parseMinor } from '../lib/savings';
import { todayIn } from '../lib/dates';

export class ActionError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length>120) throw new ActionError('Enter a name of 1–120 characters.');
  return value.trim();
}
function amount(value: unknown, whole = false): number {
  const result = typeof value==='string'?parseMinor(value):null;
  if (result===null || (whole&&result%100)) throw new ActionError(whole?'Expenses must be positive whole drams.':'Enter a positive amount with at most two decimals.');
  return result;
}
function id(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value)<=0) throw new ActionError('Invalid record.');
  return Number(value);
}
export async function dashboardAction(db: Db, sql: Database, user: number, tz: string, body: Record<string, unknown>): Promise<void> {
  if (typeof body.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.requestId)) throw new ActionError('Missing request identifier.');
  const event = `dashboard:${user}:${body.requestId}`;
  const today = todayIn(tz);
  const day = body.day === undefined ? today : body.day;
  if (typeof day!=='string' || !validDate(day) || day>today) throw new ActionError('Choose today or a past date.');
  switch (body.action) {
    case 'add-income':
      await db.income.add(user,label(body.label),amount(body.amount),day,event); return;
    case 'add-expense': {
      const category = body.categoryId===null?null:await db.category(user,id(body.categoryId));
      if (body.categoryId!==null && (!category||category.archived)) throw new ActionError('Choose an active category.');
      await sql.prepare('INSERT OR IGNORE INTO transactions(user_id,category_id,amount,note,spent_on,dashboard_event) VALUES(?,?,?,?,?,?)')
        .bind(user,category?.id??null,amount(body.amount,true)/100,label(body.label),day,event).run(); return;
    }
    case 'category': {
      const tx = await db.transaction(user,id(body.id));
      const category = await db.category(user,id(body.categoryId));
      if (!tx || !category || category.archived) throw new ActionError('The item or category changed. Refresh and try again.',409);
      await db.setTransactionCategory(user,tx.id,category.id);
      if (tx.source_chat!=null) await db.finance.alias(user,tx.note,category.id);
      return;
    }
    case 'new-category': {
      const name=label(body.label);
      if (name.length>32) throw new ActionError('Category names must be at most 32 characters.');
      if (!await db.addCategory(user,name,'')) throw new ActionError('That category already exists.',409);
      return;
    }
    case 'budget':
      await db.setBudget(user,0,amount(body.amount,true)/100); return;
    case 'save': {
      const goal = (await db.finance.goals(user)).find(g=>g.id===id(body.id));
      if (!goal) throw new ActionError('Goal not found.',404);
      await db.finance.contribute(user,goal.id,amount(body.amount),day,event); return;
    }
    case 'edit':
    case 'delete': {
      const recordId = id(body.id);
      if (body.kind!=='expense' && body.kind!=='income') throw new ActionError('Use Telegram to correct savings transfers.');
      const table=body.kind==='expense'?'transactions':'income';
      const row=await sql.prepare(`SELECT * FROM ${table} WHERE user_id=? AND id=?`).bind(user,recordId).first<Record<string,unknown>>();
      if (!row) throw new ActionError('Record no longer exists. Refresh the dashboard.',409);
      if (row.source_chat!==null) throw new ActionError('Edit the source channel table to change this amount or date. You can change its category here.');
      const amountColumn=body.kind==='expense'?'amount':'amount_minor', dateColumn=body.kind==='expense'?'spent_on':'received_on', nameColumn=body.kind==='expense'?'note':'source';
      const expected=body.expected as Record<string,unknown>|undefined;
      if (!expected || expected.amountMinor!==Number(row[amountColumn])*(body.kind==='expense'?100:1) || expected.day!==row[dateColumn] || expected.label!==row[nameColumn]) throw new ActionError('This record changed. Refresh and try again.',409);
      const guard=`user_id=? AND id=? AND source_chat IS NULL AND ${amountColumn}=? AND ${dateColumn}=? AND ${nameColumn}=?`;
      const params=[user,recordId,row[amountColumn],row[dateColumn],row[nameColumn]];
      const result=body.action==='delete'
        ? await sql.prepare(`DELETE FROM ${table} WHERE ${guard}`).bind(...params).run()
        : await sql.prepare(`UPDATE ${table} SET ${amountColumn}=?,${dateColumn}=?,${nameColumn}=? WHERE ${guard}`)
          .bind(amount(body.amount,body.kind==='expense')/(body.kind==='expense'?100:1),day,label(body.label),...params).run();
      if (!result.meta.changes) throw new ActionError('This record changed. Refresh and try again.',409);
      return;
    }
    default: throw new ActionError('Unknown action.');
  }
}
