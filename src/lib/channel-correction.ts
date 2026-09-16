import type { AppContext } from '../context';
import { changeChannelEntry } from './channel-table';
import { handleChannelPost } from '../handlers/channel';
import { ledgerEntry, matchesEntry, type EntryKind } from './ledger-entry';

/** Telegram is the source of imported entries. Preserve its formatting, then import the returned revision. */
export async function correctChannelEntry(ctx:AppContext,kind:EntryKind,id:number,expected:Record<string,unknown>,next:{amount:number;accountId:number}|null,request:string):Promise<number|null>{
  const row=await ledgerEntry(ctx.db,ctx.env.DB,ctx.userId,kind,id);
  if(!row||row.sourceChat===null||row.sourceMessage===null||!matchesEntry(row,expected))throw new Error('This entry changed. Reopen the latest entry.');
  const post=await ctx.env.DB.prepare('SELECT content,error FROM channel_posts WHERE user_id=? AND chat_id=? AND message_id=?').bind(ctx.userId,row.sourceChat,row.sourceMessage).first<{content:string|null;error:string|null}>();
  if(!post?.content||post.error)throw new Error('The source table needs attention. Open it and correct the sync error first.');
  const table=kind==='expense'?'transactions':kind==='income'?'income':'savings',signFilter=kind==='saving'?' AND amount_minor>0':kind==='withdrawal'?' AND amount_minor<0':'';
  const siblings=async()=>(await ctx.env.DB.prepare(`SELECT id FROM ${table} WHERE user_id=? AND source_chat=? AND source_message=?${signFilter} ORDER BY id`).bind(ctx.userId,row.sourceChat,row.sourceMessage).all<{id:number}>()).results;
  const rows=await siblings(),index=rows.findIndex(r=>r.id===id);
  const account=next?await ctx.db.accounts.get(ctx.userId,next.accountId):null;
  if(next&&(!account||account.archived))throw new Error('Choose an active account.');
  const direction=kind==='income'||kind==='withdrawal'?1:-1;
  const changes=new Map<number,number>([[row.accountId,-row.amount*direction]]);
  if(next)changes.set(next.accountId,(changes.get(next.accountId)??0)+next.amount*direction);
  for(const [accountId,change]of changes)if(change<0)await ctx.db.accounts.assertCanSpend(ctx.userId,accountId,-change,row.day);
  if(row.goalId){const goal=(await ctx.db.finance.goals(ctx.userId)).find(g=>g.id===row.goalId);if(!goal||goal.saved_minor+(kind==='saving'?1:-1)*((next?.amount??0)-row.amount)<0)throw new Error('This change exceeds the saved balance in the goal.');}
  const prefix=kind==='expense'?'':kind==='income'?'income:':kind==='saving'?'save:':'withdraw:';
  const label=next?`${prefix}${row.label} @ ${account!.name}${row.passive?' [passive]':''}`:'';
  const edited=changeChannelEntry(JSON.parse(post.content),ctx.tz,kind==='saving'?'save':kind==='withdrawal'?'withdraw':kind,index,next?{label,amount:next.amount/100}:null);
  const event=`correction:${ctx.userId}:${request}`;
  await ctx.env.DB.prepare("UPDATE channel_add_requests SET status='uncertain' WHERE chat_id=? AND status='pending' AND started_at<unixepoch()-600").bind(row.sourceChat).run();
  const claimed=await ctx.env.DB.prepare("INSERT INTO channel_add_requests(event_key,user_id,chat_id,status) VALUES(?,?,?,'pending') ON CONFLICT(event_key) DO NOTHING").bind(event,ctx.userId,row.sourceChat).run();
  if(!claimed.meta.changes)throw new Error('This source correction was already attempted. Check /syncstatus and reopen the latest entry.');
  let completed=false;
  try{
    const current=await ledgerEntry(ctx.db,ctx.env.DB,ctx.userId,kind,id);
    const currentPost=await ctx.env.DB.prepare('SELECT content FROM channel_posts WHERE user_id=? AND chat_id=? AND message_id=?').bind(ctx.userId,row.sourceChat,row.sourceMessage).first<{content:string|null}>();
    if(!current||!matchesEntry(current,expected)||currentPost?.content!==post.content)throw new Error('This entry changed. Reopen it.');
    const message=edited.rich?await ctx.api.editMessageText(row.sourceChat,row.sourceMessage,edited.rich):edited.caption?await ctx.api.editMessageCaption(row.sourceChat,row.sourceMessage,{caption:edited.text,caption_entities:edited.entities}):await ctx.api.editMessageText(row.sourceChat,row.sourceMessage,edited.text!,{entities:edited.entities});
    if(typeof message==='boolean')throw new Error('Telegram did not confirm the correction. Check /syncstatus.');
    await handleChannelPost(ctx,ctx.db,new Set([ctx.userId]),ctx.sign,message);
    const status=await ctx.db.finance.post(row.sourceChat,row.sourceMessage);
    if(!status||status.error)throw new Error('The channel changed but needs synchronization. Check /syncstatus before retrying.');
    completed=true;return next?(await siblings())[index]?.id??null:null;
  }catch(error){throw new Error('Channel update could not be confirmed. Check the channel and /syncstatus before retrying.',{cause:error});}
  finally{await ctx.env.DB.prepare('UPDATE channel_add_requests SET status=? WHERE event_key=?').bind(completed?'done':'uncertain',event).run();}
}
export async function correctChannelExpense(ctx:AppContext,id:number,expected:Record<string,unknown>,next:{amount:number;accountId:number}|null,request:string){return correctChannelEntry(ctx,'expense',id,expected,next,request);}
