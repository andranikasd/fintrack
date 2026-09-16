import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context';
import { minorMoney } from '../lib/savings';
import { reportTable } from '../lib/rich-report';
import { entryRecovery } from '../lib/entry-recovery';
export const transfers=new Composer<AppContext>();
export async function sendTransfers(ctx:AppContext){
  const rows=(await ctx.db.transfers.list(ctx.userId)).slice(0,10),kb=new InlineKeyboard();
  for(const row of rows)kb.text(`Undo ${row.from_name} → ${row.to_name} · ${minorMoney(row.amount_minor,ctx.sign)}`,`transfer:undo:${row.id}`).row();
  kb.text('New transfer','setup:transfer:new');
  await ctx.api.sendRichMessage(ctx.chat!.id,{blocks:[{type:'heading',size:2,text:'Account transfers'},...(rows.length?[reportTable(['Date','From / to','Amount'],rows.map(t=>[t.transferred_on,`${t.from_name} → ${t.to_name}`,minorMoney(t.amount_minor,ctx.sign)]))]:[{type:'paragraph' as const,text:'No account transfers recorded.'}]),{type:'footer',text:'Transfers change account balances. They are neither income nor spending.'}]},{reply_markup:kb});
}
transfers.command('transfers',sendTransfers);transfers.callbackQuery('transfers:list',async ctx=>{await ctx.answerCallbackQuery();await sendTransfers(ctx);});
transfers.callbackQuery(/^transfer:undo:(\d+)$/,async ctx=>{
  await ctx.answerCallbackQuery();const row=(await ctx.db.transfers.list(ctx.userId)).find(r=>r.id===Number(ctx.match[1]));if(!row){await ctx.reply('Transfer no longer available.');return;}
  const request=crypto.randomUUID().replaceAll('-','');await ctx.db.setState(ctx.userId,'transfer_undo',{id:row.id,request});
  await ctx.reply(`Undo ${minorMoney(row.amount_minor,ctx.sign)} from ${row.from_name} to ${row.to_name}? This reverses the recorded balances only.`,{reply_markup:new InlineKeyboard().text('Undo transfer',`transfer:confirm:${request}`).text('Keep transfer','transfers:list')});
});
transfers.callbackQuery(/^transfer:confirm:([a-f0-9]{32})$/,async ctx=>{
  await ctx.answerCallbackQuery();const state=await ctx.db.getState(ctx.userId);if(state?.state!=='transfer_undo'||state.payload.request!==ctx.match[1]){await ctx.reply('This confirmation expired. Open /transfers.');return;}
  try{const removed=await ctx.db.transfers.remove(ctx.userId,Number(state.payload.id));await ctx.db.clearState(ctx.userId);await ctx.reply(removed?'Transfer undone. Both balances updated.':'Transfer was already undone.');}catch(error){await ctx.reply(entryRecovery(error).message);}
});
