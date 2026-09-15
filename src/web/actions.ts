import { WorkspaceDb, WorkspaceError } from '../workspace-db';
import { workspaceAction, workspaceActions } from './workspace-actions';
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
export async function dashboardAction(db: Db, sql: Database, user: number, tz: string, body: Record<string, unknown>): Promise<unknown> {
  if (typeof body.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.requestId)) throw new ActionError('Missing request identifier.');
  const event = `dashboard:${user}:${body.requestId}`;
  const today = todayIn(tz);
  const day = body.day === undefined ? today : body.day;
  if (typeof day!=='string' || !validDate(day) || day>today) throw new ActionError('Choose today or a past date.');
  if(workspaceActions.has(String(body.action))){try{return await workspaceAction(db,new WorkspaceDb(sql),user,today,body);}catch(error){if(error instanceof WorkspaceError)throw new ActionError(error.message,409);throw error;}}
  const account = async(required=true) => {
    if (body.accountId==null) { if(required) throw new ActionError('Choose the account for this entry. Create an account first.'); return null; }
    const a=await db.accounts.get(user,id(body.accountId));
    if (!a||a.archived) throw new ActionError('Choose an active account.');
    return a.id;
  };
  switch (body.action) {
    case 'account-create':
    case 'account-edit': {
      const name=label(body.label);
      if(name.length>60) throw new ActionError('Account names must be at most 60 characters.');
      const opening=typeof body.opening==='string'?parseMinor(body.opening,true):null;
      if(opening===null) throw new ActionError('Enter a nonnegative opening balance with at most two decimals.');
      if(typeof body.openingOn!=='string'||!validDate(body.openingOn)||body.openingOn>today) throw new ActionError('Choose an opening date no later than today.');
      const passive=body.passive===true?1:0;
      const named=await db.accounts.named(user,name,true);
      if(named&&named.id!==body.id) {
        const retry=await sql.prepare('SELECT id FROM accounts WHERE user_id=? AND event_key=?').bind(user,event).first<{id:number}>();
        if(body.action==='account-create'&&retry?.id===named.id)return;
        throw new ActionError('An account already uses that name (or used it previously).');
      }
      try {
        if(body.action==='account-create') await sql.batch([
          sql.prepare('INSERT INTO accounts(user_id,name,opening_minor,opening_on,passive_income,event_key) VALUES(?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING').bind(user,name,opening,body.openingOn,passive,event),
          sql.prepare('INSERT OR IGNORE INTO account_names(user_id,name,account_id) SELECT user_id,name,id FROM accounts WHERE user_id=? AND event_key=?').bind(user,event),
        ]);
        else {
          const accountId=id(body.id),version=id(body.version);
          const results=await sql.batch([
            sql.prepare('INSERT OR IGNORE INTO account_names(user_id,name,account_id) SELECT user_id,name,id FROM accounts WHERE user_id=? AND id=?').bind(user,accountId),
            sql.prepare('UPDATE accounts SET name=?,opening_minor=?,opening_on=?,passive_income=?,archived=?,version=version+1 WHERE user_id=? AND id=? AND version=?')
              .bind(name,opening,body.openingOn,passive,body.archived===true?1:0,user,accountId,version),
            sql.prepare('INSERT OR IGNORE INTO account_names(user_id,name,account_id) SELECT user_id,name,id FROM accounts WHERE user_id=? AND id=?').bind(user,accountId),
          ]);
          if(!results[1]?.meta.changes) throw new ActionError('Account changed. Refresh and try again.',409);
        }
      } catch(error) { if(error instanceof Error&&/UNIQUE/.test(error.message)) throw new ActionError('An account with that name already exists.'); throw error; }
      return;
    }
    case 'goal-plan': {
      const name=label(body.label), target=amount(body.target), daily=body.daily?amount(body.daily):null, cap=body.cap?amount(body.cap):null;
      const deadline=body.deadline||null;
      if(deadline!==null&&(typeof deadline!=='string'||!validDate(deadline))) throw new ActionError('Choose a valid deadline.');
      if(!deadline&&!daily) throw new ActionError('Set a deadline or a daily savings amount.');
      const existing=body.id?(await db.finance.goals(user)).find(g=>g.id===id(body.id)):null;
      if(body.id&&!existing) throw new ActionError('Goal not found.',404);
      if(existing&&existing.name!==name) throw new ActionError('Keep the goal name when editing its plan.');
      await db.finance.putGoal(user,name,target,deadline as string|null,daily,0,cap); return;
    }
    case 'category-budget': {
      const category=await db.category(user,id(body.categoryId));
      if(!category||category.archived) throw new ActionError('Choose an active category.');
      if(body.amount==='') await db.clearBudget(user,category.id);
      else await db.setBudget(user,category.id,amount(body.amount,true)/100);
      return;
    }
    case 'add-income':
      await db.income.add(user,label(body.label),amount(body.amount),day,event,await account(true),body.passive===true); return;
    case 'add-expense': {
      const category = body.categoryId===null?null:await db.category(user,id(body.categoryId));
      if (body.categoryId!==null && (!category||category.archived)) throw new ActionError('Choose an active category.');
      await sql.prepare('INSERT OR IGNORE INTO transactions(user_id,category_id,amount,note,spent_on,dashboard_event,account_id) VALUES(?,?,?,?,?,?,?)')
        .bind(user,category?.id??null,amount(body.amount,true)/100,label(body.label),day,event,await account()).run(); return;
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
      await db.finance.contribute(user,goal.id,amount(body.amount),day,event,await account()); return;
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
      if (!expected || expected.amountMinor!==Number(row[amountColumn])*(body.kind==='expense'?100:1) || expected.day!==row[dateColumn] || expected.label!==row[nameColumn] || expected.accountId!==row.account_id || (body.kind==='income'&&Boolean(expected.passive)!==Boolean(row.passive))) throw new ActionError('This record changed. Refresh and try again.',409);
      const guard=`user_id=? AND id=? AND source_chat IS NULL AND ${amountColumn}=? AND ${dateColumn}=? AND ${nameColumn}=? AND account_id IS ?${body.kind==='income'?' AND passive=?':''}`;
      const params=[user,recordId,row[amountColumn],row[dateColumn],row[nameColumn],row.account_id,...(body.kind==='income'?[row.passive]:[])];
      const accountId=body.action==='edit'?await account():null;
      const result=body.action==='delete'
        ? await sql.prepare(`DELETE FROM ${table} WHERE ${guard}`).bind(...params).run()
        : await sql.prepare(`UPDATE ${table} SET ${amountColumn}=?,${dateColumn}=?,${nameColumn}=?,account_id=?${body.kind==='income'?',passive=?':''} WHERE ${guard}`)
          .bind(amount(body.amount,body.kind==='expense')/(body.kind==='expense'?100:1),day,label(body.label),accountId,...(body.kind==='income'?[body.passive===true?1:0]:[]),...params).run();
      if (!result.meta.changes) throw new ActionError('This record changed. Refresh and try again.',409);
      return;
    }
    default: throw new ActionError('Unknown action.');
  }
}
