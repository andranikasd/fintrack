import { correctChannelExpense } from '../lib/channel-correction';
import { addToChannel, escapeHtml } from './entry';
import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context';
import { todayIn, addDays } from '../lib/dates';
import { parseMinor, minorMoney, validDate } from '../lib/savings';
import { reportTable } from '../lib/rich-report';
import { entryRecovery } from '../lib/entry-recovery';
import { matchCategory, parseEntry } from '../lib/parse';
import { dashboardAction } from '../web/actions';
import { checkBudgets } from '../lib/alerts';

type Kind = 'expense'|'income'|'saving'|'withdrawal';
type Step = 'amount'|'label'|'category'|'category_name'|'account'|'day'|'review';
interface Draft {
  request: string; kind: Kind; step: Step; amount?: number; label?: string;
  categoryId?: number|null; accountId?: number; goalId?: number; day: string;
  channel?: boolean; blocked?: boolean; editing?: boolean; labelEdited?: boolean; digits?: string; items?: Array<{label:string;categoryId:number|null}>; page?: number;
  edit?: {id:number; kind:'expense'|'income'; expected:Record<string,unknown>;channel?:boolean};
}
const titles:Record<Kind,string>={expense:'Expense',income:'Income',saving:'Savings deposit',withdrawal:'Savings withdrawal'};
export const guidedEntry=new Composer<AppContext>();
const token=(d:Draft)=>d.request.replaceAll('-','');
const button=(d:Draft,action:string)=>`draft:${token(d)}:${action}`;
async function store(ctx:AppContext,d:Draft){await ctx.db.setState(ctx.userId,'guided_entry',d as unknown as Record<string,unknown>);}
async function active(ctx:AppContext):Promise<Draft|null>{const state=await ctx.db.getState(ctx.userId);return state?.state==='guided_entry'?state.payload as unknown as Draft:null;}

export async function entryMenu(ctx:AppContext):Promise<void> {
  await ctx.db.clearState(ctx.userId);
  const kb=new InlineKeyboard().text('Expense','new:expense').text('Income','new:income').row()
    .text('Save money','new:saving').text('Withdraw savings','new:withdrawal');
  await ctx.reply('What would you like to record? I’ll guide you through the item, account and amount. Nothing is recorded until you save.',{reply_markup:kb});
}
guidedEntry.command('new',entryMenu);
guidedEntry.hears('➕ Add entry',entryMenu);
guidedEntry.callbackQuery('entry:new',async ctx=>{await ctx.answerCallbackQuery();await entryMenu(ctx);});

async function show(ctx:AppContext,d:Draft,error?:string):Promise<void> {
  await store(ctx,d);
  const kb=new InlineKeyboard();
  let text=error?error+'\n\n':'';
  const account=d.accountId?await ctx.db.accounts.get(ctx.userId,d.accountId):null;
  if(d.step==='amount') {
    text+=`${d.digits||'0'} AMD\nTap the keypad or type an amount${d.kind==='expense'?' in whole drams':''}.`;
    for(const row of [['1','2','3'],['4','5','6'],['7','8','9']]){for(const digit of row)kb.text(digit,button(d,'digit:'+digit));kb.row();}
    if(d.kind!=='expense')kb.text('.',button(d,'digit:dot'));
    kb.text('0',button(d,'digit:0')).text('⌫',button(d,'digit:back')).row();
    kb.text('Clear',button(d,'digit:clear')).text('Use amount',button(d,'amount')).row();
  }
  if(d.step==='label') {
    if(d.kind==='saving'||d.kind==='withdrawal'){
      text+='Choose the savings goal.';
      for(const g of await ctx.db.finance.goals(ctx.userId))kb.text(`${g.name} · ${minorMoney(g.saved_minor,ctx.sign)}`,button(d,`goal:${g.id}`)).row();
      if(!kb.inline_keyboard.length)text+='\nCreate a goal with /goal first. Your draft is kept until you start another command.';
    }else {
      text+=d.kind==='income'?'Choose a recent source or type a name, for example Salary.':'Choose a recent item or type what you bought, for example Coffee.';
      if(!d.items){
        const table=d.kind==='expense'?'transactions':'income',name=d.kind==='expense'?"COALESCE(NULLIF(t.note,''),c.name,'Expense')":'t.source';
        d.items=(await ctx.env.DB.prepare(`SELECT ${name} AS label,${d.kind==='expense'?'t.category_id':'NULL'} AS categoryId FROM ${table} t ${d.kind==='expense'?'LEFT JOIN categories c ON c.id=t.category_id':''}
          WHERE t.user_id=? GROUP BY lower(trim(${name})) ORDER BY MAX(t.id) DESC LIMIT 60`).bind(ctx.userId).all<{label:string;categoryId:number|null}>()).results;
        await store(ctx,d);
      }
      const page=d.page??0;
      d.items.slice(page*8,page*8+8).forEach((item,index)=>{kb.text(item.label.slice(0,32),button(d,`item:${page*8+index}`));if(index%2===1)kb.row();});
      kb.row();
      if(page>0)kb.text('Previous items',button(d,`page:${page-1}`));
      if(d.items.length>(page+1)*8)kb.text('More items',button(d,`page:${page+1}`));
      kb.row();
    }
  }
  if(d.step==='category') {
    text+='Choose a category.';
    (await ctx.db.categories(ctx.userId)).forEach((c,index)=>{kb.text(`${c.emoji} ${c.name}`.trim(),button(d,`cat:${c.id}`));if(index%2===1)kb.row();});
    kb.row().text('New category',button(d,'field:category_name')).row();
    kb.text('Categorize later',button(d,'cat:0')).row();
  }
  if(d.step==='category_name')text+='Type a category name, up to 32 characters. It will be available for future expenses too.';
  if(d.step==='account') {
    const accounts=(await ctx.db.accounts.list(ctx.userId,d.day)).filter(a=>!a.archived);
    const suggested=await ctx.db.accounts.suggest(ctx.userId,d.kind,d.label??'',d.categoryId??null);
    text+=d.kind==='income'||d.kind==='withdrawal'?'Which account received it?':'Which account paid for it?';
    if(suggested)text+='\nSuggested account comes first, based on your previous entries.';
    for(const a of accounts.sort((a,b)=>Number(b.id===suggested)-Number(a.id===suggested)))kb.text(`${a.id===suggested?'Suggested: ':''}${a.name} · ${minorMoney(a.balance_minor,ctx.sign)}`,button(d,`account:${a.id}`)).row();
    if(!accounts.length)text+='\nCreate an account first: /account Card 100000, then start /new again.';
  }
  if(d.step==='day') {
    text+='When did this happen? Choose a date or send YYYY-MM-DD.';
    kb.text('Today',button(d,'date:today')).text('Yesterday',button(d,'date:yesterday')).row();
  }
  if(d.step==='review') {
    const category=d.categoryId?await ctx.db.category(ctx.userId,d.categoryId):null;
    if(d.blocked){
      kb.text('Check recent activity','entry:check').row();
    }else {
    kb.text(d.edit?'Save correction':'Save entry',button(d,'save')).row()
      .text('Edit amount',button(d,'field:amount')).text('Change account',button(d,'field:account')).row();
    if(!d.edit?.channel)kb.text('Change date',button(d,'field:day'));
    if(!d.edit?.channel)kb.text(d.kind==='saving'||d.kind==='withdrawal'?'Change goal':'Edit name',button(d,'field:label'));
    if(d.kind==='expense'&&!d.edit?.channel)kb.row().text('Change category',button(d,'field:category'));
    if(d.edit)kb.row().text('Undo entry',`correct:${d.edit.kind}:${d.edit.id}:undo`);
    }
    kb.row().text('Cancel draft',button(d,'cancel'));
    await ctx.api.sendRichMessage(ctx.chat!.id,{blocks:[
      {type:'heading',size:3,text:d.edit?'Review correction':`Review ${titles[d.kind].toLowerCase()}`},
      ...(error?[{type:'paragraph' as const,text:error}]:[]),
      reportTable(['Detail','Value'],[['Amount',minorMoney(d.amount??0,ctx.sign)],[d.kind==='expense'?'Item':d.kind==='income'?'Source':'Goal',d.label??''],['Account',account?.name??'Choose an account'],['Date',d.day],...(d.kind==='expense'?[['Category',category?.name??'Uncategorized']]:[])]),
      {type:'footer',text:'Check these details, then save. This records activity; it does not move money at your bank.'},
    ]},{reply_markup:kb});return;
  }
  if(d.editing||d.edit)kb.row().text('Back to review',button(d,'review'));
  else if(d.step!=='label')kb.row().text('Back',button(d,'back'));
  kb.text('Cancel',button(d,'cancel'));
  const stepNames:Record<Step,string>={label:d.kind==='expense'?'What did you buy?':d.kind==='income'?'Income source':'Savings goal',account:'Choose account',amount:'Enter amount',category:'Choose category',category_name:'New category',day:'Choose date',review:'Review'};
  const steps:Step[]=d.kind==='expense'?['label','account','amount','category','review']:['label','account','amount','review'];
  const position=steps.indexOf(d.step),progress=d.edit?'Editing a saved entry':d.editing?'Update your draft':position>=0?`Step ${position+1} of ${steps.length}`:'Update your draft';
  const context=[d.step!=='label'?d.label:null,d.step!=='account'?account?.name:null,d.step!=='amount'&&d.amount?minorMoney(d.amount,ctx.sign):null].filter(Boolean).join(' · ');
  const formatted=`<b>${escapeHtml(titles[d.kind])} · ${escapeHtml(stepNames[d.step])}</b>\n<i>${progress}</i>\n${context?'\n'+escapeHtml(context)+'\n':''}\n${escapeHtml(text)}`;
  const options={reply_markup:kb,parse_mode:'HTML' as const};
  if(ctx.callbackQuery?.message?.text){
    try{await ctx.editMessageText(formatted,options);}catch(error){
      if(!(error instanceof Error)||!/message is not modified/i.test(error.message))throw error;
    }
  }else await ctx.reply(formatted,options);
}
async function advance(ctx:AppContext,d:Draft):Promise<void>{
  if(d.edit||d.editing){
    d.editing=false;
    d.step=!d.label?'label':!d.accountId?'account':d.amount===undefined?'amount':d.kind==='expense'&&d.categoryId===undefined?'category':'review';
  }else{
    d.step=d.step==='label'?'account':d.step==='account'?'amount':d.step==='amount'&&d.kind==='expense'&&d.categoryId===undefined?'category':'review';
    if(d.step==='amount')d.digits=d.amount===undefined?'':String(d.amount/100);
  }
  await show(ctx,d);
}
async function useLabel(ctx:AppContext,d:Draft,label:string):Promise<void>{
  d.label=label;d.labelEdited=Boolean(d.edit);
  if(d.kind==='expense'){
    const recent=await ctx.env.DB.prepare('SELECT category_id FROM transactions WHERE user_id=? AND lower(trim(note))=lower(trim(?)) ORDER BY id DESC LIMIT 1').bind(ctx.userId,label).first<{category_id:number|null}>();
    const category=recent?.category_id?await ctx.db.category(ctx.userId,recent.category_id):null;
    d.categoryId=category&&!category.archived?category.id:matchCategory(label,await ctx.db.categories(ctx.userId)).category?.id;
  }
  await advance(ctx,d);
}
for (const [command,kind] of [['add','expense'],['income','income'],['save','saving'],['withdraw','withdrawal']] as const) {
  guidedEntry.command(command,async(ctx,next)=>{
    const label=ctx.match.trim();
    if(label&&(command!=='add'&&command!=='income'||/[\d@]/.test(label)||label.length>120||command==='add'&&parseEntry(label,ctx.tz)))return next();
    const d:Draft={request:crypto.randomUUID(),kind,step:'label',day:todayIn(ctx.tz),channel:command==='add'&&(await ctx.db.finance.channels(ctx.userId)).length>0};
    if(label)await useLabel(ctx,d,label);else await show(ctx,d);
  });
}
for(const [label,kind] of [['➕ Expense','expense'],['💰 Income','income']] as const){
  guidedEntry.hears(label,async ctx=>show(ctx,{request:crypto.randomUUID(),kind,step:'label',day:todayIn(ctx.tz),channel:kind==='expense'&&(await ctx.db.finance.channels(ctx.userId)).length>0}));
}
guidedEntry.callbackQuery(/^new:(expense|income|saving|withdrawal)$/,async ctx=>{
  await ctx.answerCallbackQuery();
  await show(ctx,{request:crypto.randomUUID(),kind:ctx.match[1] as Kind,step:'label',day:todayIn(ctx.tz),channel:ctx.match[1]==='expense'&&(await ctx.db.finance.channels(ctx.userId)).length>0});
});

export function correctionKeyboard(kind:'expense'|'income',id:number):InlineKeyboard {
  return new InlineKeyboard().text('Edit amount',`correct:${kind}:${id}:amount`).text('Change account',`correct:${kind}:${id}:account`).row()
    .text('Undo entry',`correct:${kind}:${id}:undo`).text('Add another','entry:new');
}
async function record(ctx:AppContext,kind:'expense'|'income',id:number) {
  if(kind==='expense'){
    const row=await ctx.db.transaction(ctx.userId,id);
    return row?{id,kind,amount:row.amount*100,label:row.note,categoryId:row.category_id,accountId:row.account_id!,day:row.spent_on,passive:false,sourceChat:row.source_chat,sourceMessage:row.source_message}:null;
  }
  const row=await ctx.env.DB.prepare('SELECT * FROM income WHERE user_id=? AND id=?').bind(ctx.userId,id).first<{amount_minor:number;source:string;account_id:number;received_on:string;passive:number;source_chat:number|null;source_message:number|null}>();
  return row?{id,kind,amount:row.amount_minor,label:row.source,categoryId:null,accountId:row.account_id,day:row.received_on,passive:Boolean(row.passive),sourceChat:row.source_chat,sourceMessage:row.source_message}:null;
}
guidedEntry.callbackQuery(/^correct:(expense|income):(\d+):(amount|account|undo|review)$/,async ctx=>{
  await ctx.answerCallbackQuery();
  const kind=ctx.match[1] as 'expense'|'income',row=await record(ctx,kind,Number(ctx.match[2]));
  if(!row){await ctx.reply('This entry is no longer available.',{reply_markup:new InlineKeyboard().text('Add an entry','entry:new')});return;}
  if(row.sourceChat!=null&&kind==='income'){
    const kb=new InlineKeyboard();
    if(String(row.sourceChat).startsWith('-100'))kb.url('Open source table',`https://t.me/c/${String(row.sourceChat).slice(4)}/${row.sourceMessage}`);
    await ctx.reply('This entry belongs to a channel table. Edit or remove its row in the source message so the diary and balances stay in sync.',{reply_markup:kb});return;
  }
  const expected={amountMinor:row.amount,day:row.day,label:row.label,accountId:row.accountId,passive:row.passive,categoryId:row.categoryId};
  if(ctx.match[3]==='undo'){
    const request=crypto.randomUUID();
    await ctx.db.setState(ctx.userId,'guided_undo',{request,kind,id:row.id,expected,channel:row.sourceChat!=null});
    await ctx.reply(`Undo ${minorMoney(row.amount,ctx.sign)} ${row.label||titles[kind]}?`,{reply_markup:new InlineKeyboard().text('Undo entry',`undoentry:${request.replaceAll('-','')}`).text('Keep it',`keepentry:${request.replaceAll('-','')}`)});return;
  }
  await show(ctx,{request:crypto.randomUUID(),kind,step:ctx.match[3] as Step,amount:row.amount,label:row.label||titles[kind],categoryId:row.categoryId,accountId:row.accountId,day:row.day,edit:{id:row.id,kind,expected,channel:row.sourceChat!=null}});
});
guidedEntry.callbackQuery('entry:check',async ctx=>{await ctx.answerCallbackQuery();await ctx.reply('Use /last for expenses, /incomes for income, /goal for savings, or /syncstatus for channel updates. Reopen the entry from the latest report to correct it.');});
guidedEntry.callbackQuery(/^keepentry:([a-f0-9]{32})$/,async ctx=>{
  await ctx.answerCallbackQuery();const state=await ctx.db.getState(ctx.userId);
  if(state?.state!=='guided_undo'||String(state.payload.request).replaceAll('-','')!==ctx.match[1]){await ctx.reply('This confirmation expired. Your current draft is unchanged.');return;}
  await ctx.db.clearState(ctx.userId);await ctx.reply('Entry kept.');
});
guidedEntry.callbackQuery(/^undoentry:([a-f0-9]{32})$/,async ctx=>{
  await ctx.answerCallbackQuery();const state=await ctx.db.getState(ctx.userId);
  if(state?.state!=='guided_undo'||String(state.payload.request).replaceAll('-','')!==ctx.match[1]){await ctx.reply('This confirmation expired. Open the entry again.');return;}
  try{
    if(state.payload.channel)await correctChannelExpense(ctx,Number(state.payload.id),state.payload.expected as Record<string,unknown>,null,String(state.payload.request));
    else await dashboardAction(ctx.db,ctx.env.DB,ctx.userId,ctx.tz,{...state.payload,requestId:state.payload.request,action:'delete'});
    await ctx.db.clearState(ctx.userId);await ctx.reply('Entry undone. Balances updated.',{reply_markup:new InlineKeyboard().text('Add entry','entry:new')});
  }catch(error){await ctx.reply(entryRecovery(error).message,{reply_markup:new InlineKeyboard().text('Keep entry',`keepentry:${String(state.payload.request).replaceAll('-','')}`).text('Record income','new:income')});}
});

guidedEntry.callbackQuery(/^draft:([a-f0-9]{32}):(.+)$/,async ctx=>{
  await ctx.answerCallbackQuery();const d=await active(ctx);
  if(!d||token(d)!==ctx.match[1]){await ctx.reply('This draft expired or was replaced. Start a new entry.',{reply_markup:new InlineKeyboard().text('New entry','entry:new')});return;}
  const action=ctx.match[2]!;
  if(d.blocked&&action!=='cancel'){await show(ctx,d,'Check recent activity before starting a new attempt.');return;}
  if(action==='back'){
    const previous:Partial<Record<Step,Step>>={account:'label',amount:'account',category:'amount',category_name:'category',day:'review'};
    if(previous[d.step]){d.step=previous[d.step]!;if(d.step==='amount')d.digits=d.amount===undefined?'':String(d.amount/100);}
    await show(ctx,d);return;
  }
  if(action==='review'){d.editing=true;await advance(ctx,d);return;}
  if(action.startsWith('digit:')){
    if(d.step!=='amount')return;
    const key=action.slice(6);let value=d.digits??'';
    if(key==='clear')value='';else if(key==='back')value=value.slice(0,-1);
    else if(key==='dot'&&d.kind!=='expense'&&!value.includes('.'))value=(value||'0')+'.';
    else if(/^\d$/.test(key)&&value.length<15&&(!value.includes('.')||value.split('.')[1]!.length<2))value=(value==='0'?'':value)+key;
    if(value===(d.digits??''))return;
    d.digits=value;await show(ctx,d);return;
  }
  if(action==='amount'){
    if(d.step!=='amount')return;
    const amount=parseMinor(d.digits??'');
    if(amount===null||d.kind==='expense'&&amount%100)return show(ctx,d,'Enter a positive amount first.');
    d.amount=amount;await advance(ctx,d);return;
  }
  if(action.startsWith('page:')){if(d.step!=='label')return;d.page=Math.max(0,Math.min(7,Number(action.slice(5))||0));await show(ctx,d);return;}
  if(action.startsWith('item:')){
    if(d.step!=='label')return;
    const item=d.items?.[Number(action.slice(5))];if(!item)return;
    d.label=item.label;d.labelEdited=Boolean(d.edit);d.categoryId=item.categoryId??undefined;
    if(d.categoryId){const cat=await ctx.db.category(ctx.userId,d.categoryId);if(!cat||cat.archived)d.categoryId=undefined;}
    await advance(ctx,d);return;
  }
  if(action==='cancel'){await ctx.db.clearState(ctx.userId);await ctx.reply(d.blocked?'Draft closed. Any recorded entry is unchanged.':'Draft cancelled. Nothing saved.');return;}
  if(action.startsWith('field:')){const field=action.slice(6) as Step;if(['amount','label','category','category_name','account','day'].includes(field)){if(d.edit?.channel&&!['amount','account'].includes(field))return;d.editing=d.step==='review'||d.editing;d.step=field;if(field==='amount')d.digits=String((d.amount??0)/100);await show(ctx,d);}return;}
  if(action.startsWith('cat:')){const id=Number(action.slice(4));const c=id?await ctx.db.category(ctx.userId,id):null;if(id&&(!c||c.archived))return show(ctx,d,'Choose an active category.');d.categoryId=id||null;}
  else if(action.startsWith('account:')){const id=Number(action.slice(8));const a=await ctx.db.accounts.get(ctx.userId,id);if(!a||a.archived)return show(ctx,d,'Choose an active account.');d.accountId=id;}
  else if(action.startsWith('goal:')){const g=(await ctx.db.finance.goals(ctx.userId)).find(g=>g.id===Number(action.slice(5)));if(!g)return show(ctx,d,'Choose an existing goal.');d.goalId=g.id;d.label=g.name;}
  else if(action.startsWith('date:'))d.day=action.endsWith('yesterday')?addDays(todayIn(ctx.tz),-1):todayIn(ctx.tz);
  else if(action==='save'){
    if(d.step!=='review'){await show(ctx,d,'Finish this step before saving.');return;}
    if(!d.amount||!d.label||!d.accountId||d.kind==='expense'&&d.categoryId===undefined)return advance(ctx,d);
    let correctedChannelId:number|null=null;
    try{
      if(d.channel&&!d.edit){
        const saved=await addToChannel(ctx,{amount:d.amount/100,rest:d.label,spentOn:d.day,event:`guided:${ctx.userId}:${d.request}`},d.accountId,d.categoryId);
        if(!saved){await show(ctx,d,'Your draft is kept. Follow the guidance above before retrying.');return;}
        return;
      }
      if(d.edit?.channel)correctedChannelId=await correctChannelExpense(ctx,d.edit.id,d.edit.expected,{amount:d.amount,accountId:d.accountId},d.request);
      else await dashboardAction(ctx.db,ctx.env.DB,ctx.userId,ctx.tz,{action:d.edit?'edit':d.kind==='expense'?'add-expense':d.kind==='income'?'add-income':d.kind==='saving'?'save':'withdraw',
        requestId:d.request,amount:String(d.amount/100),label:d.labelEdited?d.label:d.edit?.expected.label??d.label,day:d.day,accountId:d.accountId,categoryId:d.categoryId??null,id:d.edit?.id??d.goalId,kind:d.edit?.kind,expected:d.edit?.expected,passive:d.edit?.expected.passive??false});
    }catch(error){const recovery=entryRecovery(error);d.step='review';d.blocked=!recovery.retrySafe;await show(ctx,d,recovery.message);return;}
    await ctx.db.clearState(ctx.userId);
    let kb=new InlineKeyboard().text('Add another','entry:new');
    if(d.kind==='expense'||d.kind==='income'){
      const table=d.kind==='expense'?'transactions':'income',column=d.kind==='expense'?'dashboard_event':'event_key';
      const id=correctedChannelId??(d.edit?.channel?null:d.edit?.id)??await ctx.env.DB.prepare(`SELECT id FROM ${table} WHERE user_id=? AND ${column}=?`).bind(ctx.userId,`dashboard:${ctx.userId}:${d.request}`).first<number>('id');
      if(id)kb=correctionKeyboard(d.kind,id);
    }
    const account=(await ctx.db.accounts.list(ctx.userId,todayIn(ctx.tz))).find(a=>a.id===d.accountId);
    await ctx.api.sendRichMessage(ctx.chat!.id,{blocks:[
      {type:'heading',size:3,text:d.edit?'Correction saved':'Entry saved'},
      reportTable(['Detail','Value'],[[d.kind==='income'?'Source':d.kind==='expense'?'Item':'Goal',d.label],['Amount',minorMoney(d.amount,ctx.sign)],['Account',account?.name??'Account'],['Date',d.day],...(account?[['Account balance',minorMoney(account.balance_minor,ctx.sign)]]:[])]),
      {type:'footer',text:'Your records and balances are up to date.'},
    ]},{reply_markup:kb});
    if(d.kind==='expense')await checkBudgets(ctx.db,ctx.api,ctx.userId,ctx.chat!.id,d.day,d.categoryId??null,ctx.sign);
    return;
  }
  await advance(ctx,d);
});

guidedEntry.on('message:text',async(ctx,next)=>{
  if(ctx.message.text.startsWith('/'))return next();
  const d=await active(ctx);if(!d)return next();
  const text=ctx.message.text.trim();
  if(d.step==='amount'){
    const amount=parseMinor(text);
    if(amount===null||d.kind==='expense'&&amount%100)return show(ctx,d,d.kind==='expense'?'Enter a positive whole AMD amount, for example 1500.':'Enter a positive amount with at most two decimals.');
    d.amount=amount;d.digits=String(amount/100);
  }else if(d.step==='category_name'){
    if(!text||text.length>32)return show(ctx,d,'Use a category name of 1–32 characters.');
    let category=(await ctx.db.categories(ctx.userId)).find(c=>c.name.toLowerCase()===text.toLowerCase());
    if(!category){if(!await ctx.db.addCategory(ctx.userId,text,''))return show(ctx,d,'That name is already used. Choose another name or go Back to the category list.');category=(await ctx.db.categories(ctx.userId)).find(c=>c.name.toLowerCase()===text.toLowerCase());}
    if(!category)return show(ctx,d,'Could not find that category. Try another name.');
    d.categoryId=category.id;d.step='category';
  }else if(d.step==='label'&&(d.kind==='expense'||d.kind==='income')){
    if(!text||text.length>120)return show(ctx,d,'Use 1–120 characters.');
    await useLabel(ctx,d,text);return;

  }else if(d.step==='day'){
    if(!validDate(text)||text>todayIn(ctx.tz))return show(ctx,d,'Use today or a past date in YYYY-MM-DD format.');d.day=text;
  }else return show(ctx,d,'Use the buttons below to continue, or Cancel to discard this draft.');
  await advance(ctx,d);
});
