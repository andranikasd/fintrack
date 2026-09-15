import { reportTable } from '../lib/rich-report';
import { dashboardAction } from '../web/actions';
import { accountEntry } from '../lib/account-entry';
import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context';
import { monthOf, monthStart, monthEnd, todayIn } from '../lib/dates';
import { minorMoney, parseMinor, validDate } from '../lib/savings';

export const income = new Composer<AppContext>();
income.command('account', async ctx=>{
  const match=/^(.+?)\s+([\d,.]+)(?:\s+(\d{4}-\d{2}-\d{2}))?$/.exec(ctx.match.trim());
  if(!match){await ctx.reply('Create an account: /account Card 100000 or /account Card 100000 2026-09-01. The balance is before the opening day’s activity. Edit accounts and passive-income settings in /dashboard.');return;}
  if(await ctx.db.accounts.named(ctx.userId,match[1]!.trim())){await ctx.reply('That account already exists. Edit it in /dashboard.');return;}
  try { await dashboardAction(ctx.db,ctx.env.DB,ctx.userId,ctx.tz,{action:'account-create',label:match[1],opening:match[2],openingOn:match[3]||todayIn(ctx.tz),requestId:crypto.randomUUID()});
    await ctx.reply('Account created. Record income with /income Salary @ '+match[1]+' 450000. Edit account details in /dashboard.');
  }catch(error){await ctx.reply(error instanceof Error?error.message:'Could not create account.');}
});
income.command('accounts',async ctx=>{
  const rows=await ctx.db.accounts.list(ctx.userId,todayIn(ctx.tz));
  if(!rows.length){await ctx.reply('No accounts yet. /account Card 100000');return;}
  await ctx.api.sendRichMessage(ctx.chat.id,{blocks:[
    {type:'heading',size:2,text:'Your accounts'},
    reportTable(['Account','Balance'],rows.map(a=>[a.name+(a.archived?' (archived)':''),minorMoney(a.balance_minor,ctx.sign)])),
    {type:'paragraph',text:{type:'bold',text:'Total: '+minorMoney(rows.reduce((sum,a)=>sum+a.balance_minor,0),ctx.sign)}},
    {type:'footer',text:'Balances include income, spending and savings transfers from the opening date. /dashboard to edit.'},
    ...(rows.some(a=>a.balance_minor<0)?[{type:'paragraph' as const,text:'⚠ Historical negative balances need correction. Check the source entries or opening balance in /dashboard.'}]:[]),
  ]});
});
income.command('income', async ctx => {
  const arg = ctx.match.trim();
  const today = todayIn(ctx.tz);
  if (arg) {
    const match = /^(.+?)\s+([\d,.]+[km]?)(?:\s+(\d{4}-\d{2}-\d{2}))?$/i.exec(arg);
    const amount = match ? parseMinor(match[2]!) : null;
    const day = match?.[3] ?? today;
    if (!match || !match[1]!.trim() || match[1]!.length > 120 || amount === null || !validDate(day) || day > today) {
      await ctx.reply('Use /income Salary @ Card 450000 or /income Freelance @ Card 25000.50 2026-09-15. Only record money received.\nIn a channel table, use income:Salary @ Card | 450000.');
      return;
    }
    const entry=accountEntry(match[1]!.trim());
    const account=entry.accountName?await ctx.db.accounts.named(ctx.userId,entry.accountName):null;
    if(!account) { await ctx.reply('Choose the receiving account: /income Salary @ Card 450000. Add or edit accounts in /dashboard. For passive income: /income Interest @ Savings [passive] 1500'); return; }
    const added = await ctx.db.income.add(ctx.userId,entry.label,amount,day,`message:${ctx.chat.id}:${ctx.message!.message_id}`,account.id,entry.passive);
    await ctx.reply(added ? `Income recorded: ${minorMoney(amount,ctx.sign)} from ${match[1]} on ${day}.` : 'This income was already recorded.');
  }
  const from = monthStart(monthOf(today)), to = monthEnd(monthOf(today));
  const [total, sources, rows] = await Promise.all([
    ctx.db.income.total(ctx.userId,from,to), ctx.db.income.bySource(ctx.userId,from,to), ctx.db.income.list(ctx.userId,from,to,10),
  ]);
  const keyboard = new InlineKeyboard();
  for (const row of rows.filter(r=>r.source_chat===null)) keyboard.text(`Remove ${row.source.slice(0,30)} ${minorMoney(row.amount_minor,ctx.sign)}`,`income:remove:${row.id}`).row();
  await ctx.api.sendRichMessage(ctx.chat.id,{blocks:[
    {type:'heading',size:2,text:`Income · ${monthOf(today)}`},
    {type:'paragraph',text:{type:'bold',text:`Received: ${minorMoney(total,ctx.sign)}`}},
    ...(sources.length?[reportTable(['Source','Received'],sources.slice(0,15).map(r=>[r.source,minorMoney(r.total,ctx.sign)]))]:[{type:'paragraph' as const,text:'No income recorded. /income Salary @ Card 450000'}]),
    {type:'footer',text:'Income does not change your chosen spending budget.'},
  ]},{reply_markup:keyboard});
});
income.callbackQuery(/^income:remove:(\d+)$/, async ctx => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Remove this income entry?', {reply_markup:new InlineKeyboard().text('Remove income',`income:confirm:${ctx.match[1]}`).text('Keep it','income:keep')});
});
income.callbackQuery('income:keep', async ctx => { await ctx.answerCallbackQuery(); await ctx.editMessageText('Income kept. /income to view it.'); });
income.callbackQuery(/^income:confirm:(\d+)$/, async ctx => {
  const removed = await ctx.db.income.remove(ctx.userId,Number(ctx.match[1]));
  await ctx.answerCallbackQuery({text:removed?'Income removed':'Already removed, or edit the source channel table.'});
  if (removed) await ctx.editMessageText('Income removed. /income to view the updated total.');
});
