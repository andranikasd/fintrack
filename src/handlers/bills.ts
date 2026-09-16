import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context';
import { todayIn } from '../lib/dates';
import { minorMoney } from '../lib/savings';
import { reportTable } from '../lib/rich-report';
import { entryRecovery } from '../lib/entry-recovery';
import { correctionKeyboard } from './guided-entry';
import { checkBudgets } from '../lib/alerts';
export const bills=new Composer<AppContext>();
export function billKeyboard(id:number){return new InlineKeyboard().text('Paid today',`bill:paid:${id}`).text('Skip this payment',`bill:skip:${id}`).row().text('Manage bills','bills:list');}
export async function sendBills(ctx:AppContext){
  const rows=await ctx.db.bills.list(ctx.userId),kb=new InlineKeyboard();
  for(const b of rows)kb.text(`${b.enabled?'Edit':'Paused:'} ${b.label.slice(0,32)}`,`setup:bill:${b.id}`).row();
  kb.text('New recurring bill','setup:bill:new');
  await ctx.api.sendRichMessage(ctx.chat!.id,{blocks:[{type:'heading',size:2,text:'Recurring bills'},...(rows.length?[reportTable(['Bill','Amount','Next due'],rows.map(b=>[b.label+(b.enabled?'':' (paused)'),minorMoney(b.amount_minor,ctx.sign),b.next_due]))]:[{type:'paragraph' as const,text:'Add a subscription or regular bill. You will get a reminder when it is due.'}]),{type:'footer',text:`Reminders use ${ctx.tz}. A reminder never records spending until you confirm payment.`}]},{reply_markup:kb});
}
bills.command('bills',sendBills);bills.callbackQuery('bills:list',async ctx=>{await ctx.answerCallbackQuery();await sendBills(ctx);});
bills.callbackQuery(/^bill:(paid|force|skip|skipconfirm|link):(\d+)(?::(\d+))?$/,async ctx=>{
  await ctx.answerCallbackQuery();const id=Number(ctx.match[2]),o=await ctx.db.bills.occurrence(ctx.userId,id),action=ctx.match[1];
  if(!o||o.status!=='pending'){await ctx.reply('This reminder is already handled or no longer available.');return;}
  const rule=await ctx.db.bills.get(ctx.userId,o.rule_id);
  if(!rule||!rule.enabled||rule.version!==o.rule_version){await ctx.reply('The bill changed. Open /bills for its current settings.');return;}
  if(action==='skip'){await ctx.reply(`Skip the ${o.due_on} payment for ${o.label}? This advances the reminder without recording an expense.`,{reply_markup:new InlineKeyboard().text('Skip this payment',`bill:skipconfirm:${id}`).text('Keep reminder','bills:list')});return;}
  const day=todayIn(ctx.tz);
  if(action==='paid'){
    const matches=await ctx.db.bills.matches(ctx.userId,o,day);
    if(matches.length){const kb=new InlineKeyboard();for(const r of matches)kb.text(`Already recorded: #${r.id}`,`bill:link:${id}:${r.id}`).row();kb.text('Record another payment',`bill:force:${id}`);
      await ctx.reply(`A matching ${minorMoney(o.amount_minor,ctx.sign)} ${o.label} expense exists today. Link it, or confirm this was another payment.`,{reply_markup:kb});return;}
  }
  try{
    const result=await ctx.db.bills.resolve(ctx.userId,id,day,action==='skipconfirm'?'skip':'paid',action==='link'?Number(ctx.match[3]):undefined);
    if(result===null){await ctx.reply('This reminder was already handled.');return;}
    await ctx.reply(action==='skipconfirm'?'Payment skipped. The next reminder is scheduled.':`Payment recorded for ${day}. The next reminder is scheduled.`,{reply_markup:result?correctionKeyboard('expense',result):new InlineKeyboard().text('View bills','bills:list')});
    if(result)await checkBudgets(ctx.db,ctx.api,ctx.userId,ctx.chat!.id,day,o.category_id,ctx.sign);
  }catch(error){await ctx.reply(entryRecovery(error).message,{reply_markup:billKeyboard(id)});}
});
