import type { AppContext } from '../context';
import { changeChannelExpense } from './channel-table';
import { handleChannelPost } from '../handlers/channel';

/** Telegram is the source of channel rows. Edit it first, then import its returned revision. */
export async function correctChannelExpense(ctx:AppContext,id:number,expected:Record<string,unknown>,next:{amount:number;accountId:number}|null,request:string):Promise<number|null> {
  const tx=await ctx.db.transaction(ctx.userId,id);
  if(!tx||tx.source_chat==null||tx.source_message==null||tx.amount*100!==expected.amountMinor||tx.account_id!==expected.accountId||tx.note!==expected.label||tx.spent_on!==expected.day)throw new Error('This entry changed. Reopen the latest entry.');
  const post=await ctx.env.DB.prepare('SELECT content,error FROM channel_posts WHERE user_id=? AND chat_id=? AND message_id=?').bind(ctx.userId,tx.source_chat,tx.source_message).first<{content:string|null;error:string|null}>();
  if(!post?.content||post.error)throw new Error('The source table needs attention. Open it and correct the sync error first.');
  const rows=(await ctx.env.DB.prepare('SELECT id FROM transactions WHERE user_id=? AND source_chat=? AND source_message=? ORDER BY id').bind(ctx.userId,tx.source_chat,tx.source_message).all<{id:number}>()).results;
  const account=next?await ctx.db.accounts.get(ctx.userId,next.accountId):null;
  if(next&&(!account||account.archived))throw new Error('Choose an active account.');
  if(next)await ctx.db.accounts.assertCanSpend(ctx.userId,next.accountId,Math.max(0,next.amount-(tx.account_id===next.accountId?tx.amount*100:0)),tx.spent_on);
  const edited=changeChannelExpense(JSON.parse(post.content),ctx.tz,rows.findIndex(r=>r.id===id),next?{label:`${tx.note} @ ${account!.name}`,amount:next.amount/100}:null);
  const event=`correction:${ctx.userId}:${request}`;
  const claimed=await ctx.env.DB.prepare("INSERT INTO channel_add_requests(event_key,user_id,chat_id,status) VALUES(?,?,?,'pending') ON CONFLICT(event_key) DO NOTHING").bind(event,ctx.userId,tx.source_chat).run();
  if(!claimed.meta.changes)throw new Error('This source correction was already attempted. Check /syncstatus and reopen the latest entry before trying again.');
  let completed=false;
  try {
    const current=await ctx.db.transaction(ctx.userId,id);
    const currentPost=await ctx.env.DB.prepare('SELECT content FROM channel_posts WHERE user_id=? AND chat_id=? AND message_id=?').bind(ctx.userId,tx.source_chat,tx.source_message).first<{content:string|null}>();
    if(!current||currentPost?.content!==post.content||current.amount!==tx.amount||current.account_id!==tx.account_id||current.note!==tx.note||current.spent_on!==tx.spent_on)throw new Error('This entry changed. Reopen it.');
    const message=edited.rich?await ctx.api.editMessageText(tx.source_chat,tx.source_message,edited.rich):edited.caption?
      await ctx.api.editMessageCaption(tx.source_chat,tx.source_message,{caption:edited.text,caption_entities:edited.entities}):
      await ctx.api.editMessageText(tx.source_chat,tx.source_message,edited.text!,{entities:edited.entities});
    if(typeof message==='boolean')throw new Error('Telegram did not confirm the correction. Check /syncstatus.');
    await handleChannelPost(ctx,ctx.db,new Set([ctx.userId]),ctx.sign,message);
    const status=await ctx.db.finance.post(tx.source_chat,tx.source_message);
    if(!status||status.error)throw new Error('The channel changed but needs synchronization. Check /syncstatus before retrying.');
    completed=true;
    if(!next)return null;
    const updated=(await ctx.env.DB.prepare('SELECT id FROM transactions WHERE user_id=? AND source_chat=? AND source_message=? ORDER BY id').bind(ctx.userId,tx.source_chat,tx.source_message).all<{id:number}>()).results;
    return updated[rows.findIndex(r=>r.id===id)]?.id??null;
  } catch(error){
    throw new Error('Channel update could not be confirmed. Check the channel and /syncstatus before retrying.',{cause:error});
  } finally {await ctx.env.DB.prepare('UPDATE channel_add_requests SET status=? WHERE event_key=?').bind(completed?'done':'uncertain',event).run();}
}
