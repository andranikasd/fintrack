import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context';
import { showCurrentEntry } from './guided-entry';
import { showCurrentForm } from './finance-forms';
export const drafts=new Composer<AppContext>();
async function list(ctx:AppContext){
  await ctx.db.pauseDraft(ctx.userId);
  const rows=await ctx.db.drafts(ctx.userId),kb=new InlineKeyboard();
  for(const row of rows){const payload=JSON.parse(row.payload);const label=payload.label??payload.values?.label??payload.kind??'Entry';kb.text(`Continue ${String(label).slice(0,32)}`,`resume:${row.request}`).text('Discard',`discard:${row.request}`).row();}
  if(!rows.length)kb.text('Add entry','entry:new');
  await ctx.reply(rows.length?(rows.length===30?'Showing your 30 most recent drafts. Continue or discard one to see older drafts. ':'')+'Choose a draft to continue. Amounts are not recorded until you save.':'No unfinished drafts.',{reply_markup:kb});
}
drafts.command(['resume','drafts'],list);
drafts.callbackQuery('drafts:list',async ctx=>{await ctx.answerCallbackQuery();await list(ctx);});
drafts.callbackQuery(/^resume:([a-f0-9]{32})$/,async ctx=>{
  await ctx.answerCallbackQuery();if(!await ctx.db.resumeDraft(ctx.userId,ctx.match[1]!)){await ctx.reply('That draft is no longer available. Use /drafts.');return;}
  const state=await ctx.db.getState(ctx.userId);if(state?.state==='guided_entry')await showCurrentEntry(ctx);else await showCurrentForm(ctx);
});
drafts.callbackQuery(/^discard:([a-f0-9]{32})$/,async ctx=>{await ctx.answerCallbackQuery();await ctx.db.discardDraft(ctx.userId,ctx.match[1]!);await list(ctx);});
