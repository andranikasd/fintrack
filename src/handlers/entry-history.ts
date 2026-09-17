import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context';
import { reportTable } from '../lib/rich-report';
import { minorMoney } from '../lib/savings';
import type { EntryKind } from '../lib/ledger-entry';

interface Search {token:string;query:string;kind:EntryKind|'all';page:number;typing?:boolean}
interface Row {id:number;kind:EntryKind;day:string;label:string;amount:number;account:string}
export const entryHistory=new Composer<AppContext>();
const kinds=['all','expense','income','saving','withdrawal'] as const;
const labels={all:'All entries',expense:'Expenses',income:'Income',saving:'Deposits',withdrawal:'Withdrawals'};

async function show(ctx:AppContext,s:Search){
  s.typing=false;await ctx.db.setState(ctx.userId,'entry_history',s as unknown as Record<string,unknown>);
  // Query the ledger directly: no age cutoff or export/recent-list row limit.
  const rows=(await ctx.env.DB.prepare(`WITH entries AS (
    SELECT id,'expense' AS kind,spent_on AS day,COALESCE(NULLIF(note,''),'Expense') AS label,amount*100 AS amount,account_id FROM transactions WHERE user_id=?1
    UNION ALL SELECT id,'income',received_on,source,amount_minor,account_id FROM income WHERE user_id=?1
    UNION ALL SELECT s.id,CASE WHEN amount_minor>0 THEN 'saving' ELSE 'withdrawal' END,saved_on,g.name,ABS(amount_minor),account_id FROM savings s JOIN goals g ON g.id=s.goal_id AND g.user_id=s.user_id WHERE s.user_id=?1
  ) SELECT e.*,COALESCE(a.name,'Unassigned') AS account FROM entries e LEFT JOIN accounts a ON a.id=e.account_id AND a.user_id=?1
    WHERE (?2='all' OR kind=?2) AND (?3='' OR CASE WHEN ?4=1 THEN substr(day,1,length(?3))=?3 ELSE instr(lower(label),lower(?3))>0 END)
    ORDER BY day DESC,id DESC,kind LIMIT 9 OFFSET ?5`)
    .bind(ctx.userId,s.kind,s.query,/^\d{4}-\d{2}(?:-\d{2})?$/.test(s.query)?1:0,s.page*8).all<Row>()).results;
  const shown=rows.slice(0,8),kb=new InlineKeyboard(),key=(a:string)=>`history:${s.token}:${a}`;
  for(const r of shown)kb.text(`${r.day} · ${r.label.slice(0,26)} · ${minorMoney(r.amount,ctx.sign)}`,`correct:${r.kind}:${r.id}:review`).row();
  if(s.page)kb.text('Newer',key('prev'));if(rows.length>8)kb.text('Older',key('next'));kb.row();
  kb.text('Search item or date',key('search')).text('Clear search',key('clear')).row();
  for(const [i,kind]of kinds.entries()){kb.text((kind===s.kind?'✓ ':'')+labels[kind],key('kind:'+kind));if(i%2===1)kb.row();}
  await ctx.api.sendRichMessage(ctx.chat!.id,{blocks:[
    {type:'heading',size:2,text:`Find an entry · ${labels[s.kind]}`},
    {type:'paragraph',text:`Page ${s.page+1}${s.query?' · Search: '+s.query:''}. All recorded dates are available.`},
    ...(shown.length?[reportTable(['Date','Type / item','Account','Amount'],shown.map(r=>[r.day,labels[r.kind]+' · '+r.label,r.account,minorMoney(r.amount,ctx.sign)]))]:[{type:'paragraph' as const,text:'No matching entries. Clear the search or choose another type.'}]),
    {type:'footer',text:'Tap an entry, change its details, then review and save. Browsing never changes your records.'},
  ]},{reply_markup:kb});
}
export async function openHistory(ctx:AppContext,query='',kind:Search['kind']='all'){
  if(query.length>120){await ctx.reply('Use an item name of up to 120 characters, or a date such as 2025-06.');return;}
  await show(ctx,{token:crypto.randomUUID().replaceAll('-','').slice(0,16),query,kind,page:0});
}
entryHistory.command(['history','edit'],async(ctx,next)=>{
  const query=ctx.match.trim();if(/^\/edit(?:@\w+)?\s/.test(ctx.message!.text!)&&/^(expense|income|saving|withdrawal)\s+[1-9]\d*$/.test(query))return next();
  await openHistory(ctx,query);
});
entryHistory.callbackQuery(/^history:open(?::(expense|income|saving|withdrawal))?$/,async ctx=>{await ctx.answerCallbackQuery();await openHistory(ctx,'',(ctx.match[1]||'all') as Search['kind']);});
entryHistory.callbackQuery(/^history:([a-f0-9]{16}):(prev|next|search|clear|kind:(?:all|expense|income|saving|withdrawal))$/,async ctx=>{
  await ctx.answerCallbackQuery();const state=await ctx.db.getState(ctx.userId),s=state?.state==='entry_history'?state.payload as unknown as Search:null;
  if(!s||s.token!==ctx.match[1]){await ctx.reply('This search has expired. Open /edit to browse your current records.');return;}
  const action=ctx.match[2]!;
  if(action==='search'){s.typing=true;await ctx.db.setState(ctx.userId,'entry_history',s as unknown as Record<string,unknown>);await ctx.reply('Type part of an item/source/goal name, a month (YYYY-MM), or an exact date (YYYY-MM-DD). /edit starts again.');return;}
  if(action==='next')s.page++;else if(action==='prev')s.page=Math.max(0,s.page-1);else if(action==='clear'){s.query='';s.page=0;}else if(action.startsWith('kind:')){s.kind=action.slice(5) as Search['kind'];s.page=0;}
  await show(ctx,s);
});
entryHistory.on('message:text',async(ctx,next)=>{
  if(ctx.message.text.startsWith('/'))return next();const state=await ctx.db.getState(ctx.userId);if(state?.state!=='entry_history')return next();
  const s=state.payload as unknown as Search;if(!s.typing){await ctx.reply('Tap an entry or Search item or date. /add records a new purchase.');return;}
  const query=ctx.message.text.trim();if(!query||query.length>120){await ctx.reply('Enter 1–120 characters, or /edit to start again.');return;}
  s.query=query;s.page=0;await show(ctx,s);
});
