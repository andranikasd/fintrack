import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context';
import { dashboardAction } from '../web/actions';
import { todayIn, addDays } from '../lib/dates';
import { minorMoney, parseMinor, validDate } from '../lib/savings';
import { reportTable } from '../lib/rich-report';
import { entryRecovery } from '../lib/entry-recovery';
import { escapeHtml } from './entry';

type FormKind='account'|'goal'|'transfer'|'bill';
type Values=Record<string,string>;
interface FormDraft {request:string;kind:FormKind;index:number;values:Values;id?:number;version?:number;editing?:boolean;buffer?:string;blocked?:boolean}
interface Field {key:string;title:string;type:'text'|'money'|'date'|'choice'|'account'|'category'|'time';hint?:string;choices?:Array<[string,string]>;zero?:boolean;optional?:boolean;max?:number;future?:boolean;whole?:boolean}
export const financeForms=new Composer<AppContext>();
const title:Record<FormKind,string>={account:'Account',goal:'Savings goal',transfer:'Account transfer',bill:'Recurring bill'};
const token=(d:FormDraft)=>d.request.replaceAll('-','');
const callback=(d:FormDraft,action:string)=>`f:${token(d)}:${action}`;
function fields(d:FormDraft):Field[]{
  if(d.kind==='account')return [{key:'label',title:'Account name',type:'text',max:60,hint:'For example Card, Cash or Savings.'},{key:'opening',title:'Opening balance',type:'money',zero:true,hint:'The balance before activity on the opening date. This is not income.'},{key:'openingOn',title:'Opening date',type:'date'},{key:'passive',title:'Does this account earn passive income?',type:'choice',choices:[['No','false'],['Yes','true']]},...(d.id?[{key:'archived',title:'Account availability',type:'choice' as const,choices:[['Active','false'],['Archive, keep history','true']] as Array<[string,string]>}]:[])];
  if(d.kind==='goal')return [...(!d.id?[{key:'label',title:'Goal name',type:'text' as const,max:40,hint:'For example Laptop or Holiday.'}]:[]),{key:'target',title:'Target amount',type:'money'},{key:'plan',title:'How would you like to plan?',type:'choice',choices:[['Daily amount','daily'],['Target date','deadline']]},...(d.values.plan==='deadline'?[{key:'deadline',title:'Target date',type:'date' as const,future:true}]:[{key:'daily',title:'Planned amount per day',type:'money' as const}]),{key:'opening',title:'Starting saved amount',type:'money',zero:true,hint:'Savings already held before the contributions recorded here. Editing this does not change account balances.'},{key:'cap',title:'Daily contribution limit',type:'money',optional:true,hint:'Optional. Choose Skip for no daily cap.'}];
  if(d.kind==='transfer')return [{key:'source',title:'From which account?',type:'account'},{key:'destination',title:'To which account?',type:'account'},{key:'amount',title:'Transfer amount',type:'money'},{key:'day',title:'Transfer date',type:'date'},{key:'note',title:'Transfer note',type:'text',optional:true,max:120,hint:'Optional. For example ATM withdrawal or moved to savings account.'}];
  return [{key:'label',title:'Bill name',type:'text',max:120,hint:'For example Internet, Rent or Spotify.'},{key:'amount',title:'Usual payment amount',type:'money',whole:true},{key:'accountId',title:'Paying account',type:'account'},{key:'categoryId',title:'Expense category',type:'category',optional:true},{key:'frequency',title:'How often is it due?',type:'choice',choices:[['Every month','monthly'],['Every week','weekly']]},{key:'nextDue',title:'Next due date',type:'date',future:true},{key:'time',title:'Reminder time',type:'time',hint:'Use HH:MM in your Telegram timezone. No expense is recorded until you confirm payment.'},...(d.id?[{key:'enabled',title:'Reminder status',type:'choice' as const,choices:[['Enabled','true'],['Paused','false']] as Array<[string,string]>}]:[])];
}
async function active(ctx:AppContext){const s=await ctx.db.getState(ctx.userId);return s?.state==='guided_form'?s.payload as unknown as FormDraft:null;}
async function start(ctx:AppContext,kind:FormKind,id?:number){
  const day=todayIn(ctx.tz),values:Values={opening:'0',openingOn:day,passive:'false',archived:'false',plan:'daily',cap:'',day,note:'',categoryId:'',frequency:'monthly',nextDue:day,time:'09:00',enabled:'true'};
  const d:FormDraft={kind,request:crypto.randomUUID(),index:0,values,id};
  if(id&&kind==='account'){
    const a=await ctx.db.accounts.get(ctx.userId,id);if(!a)return ctx.reply('Account unavailable. Open /accounts.');
    Object.assign(values,{label:a.name,opening:String(a.opening_minor/100),openingOn:a.opening_on,passive:String(Boolean(a.passive_income)),archived:String(Boolean(a.archived))});d.version=a.version;
  }else if(id&&kind==='goal'){
    const g=(await ctx.db.finance.goals(ctx.userId)).find(g=>g.id===id);if(!g)return ctx.reply('Goal unavailable. Open /goal.');
    Object.assign(values,{label:g.name,target:String(g.target_minor/100),plan:g.deadline?'deadline':'daily',deadline:g.deadline??'',daily:g.daily_minor?String(g.daily_minor/100):'',opening:String(g.opening_minor/100),cap:g.cap_minor?String(g.cap_minor/100):''});d.version=g.version;
  }else if(id&&kind==='bill'){
    const b=await ctx.db.bills.get(ctx.userId,id);if(!b)return ctx.reply('Bill unavailable. Open /bills.');
    Object.assign(values,{label:b.label,amount:String(b.amount_minor/100),accountId:String(b.account_id),categoryId:b.category_id?String(b.category_id):'',frequency:b.frequency,nextDue:b.next_due,time:b.remind_time,enabled:String(Boolean(b.enabled))});d.version=b.version;
  }
  if(id)d.index=fields(d).length;
  await showForm(ctx,d);
}
export async function showCurrentForm(ctx:AppContext){const d=await active(ctx);if(d)await showForm(ctx,d);}
async function showForm(ctx:AppContext,d:FormDraft,error?:string):Promise<void>{
  const list=fields(d),field=list[d.index],kb=new InlineKeyboard();
  if(!field){
    const rows:Array<[string,string]>=[];
    if(d.id&&d.kind==='goal')rows.push(['Goal',d.values.label!]);
    for(const f of list){let value=d.values[f.key]??'';
      if(f.type==='money')value=value?minorMoney(parseMinor(value,true)??0,ctx.sign):'No limit';
      if(f.type==='choice')value=f.choices!.find(c=>c[1]===value)?.[0]??value;
      if(f.type==='account')value=(await ctx.db.accounts.get(ctx.userId,Number(value)))?.name??'Choose an account';
      if(f.type==='category')value=value?(await ctx.db.category(ctx.userId,Number(value)))?.name??'Unavailable':'Uncategorized';
      rows.push([f.title,value||'None']);
    }
    if(!d.blocked){kb.text(d.kind==='transfer'?'Record transfer':'Save '+title[d.kind].toLowerCase(),callback(d,'save')).row();list.forEach((f,i)=>{kb.text(f.title,callback(d,`edit:${i}`));if(i%2===1)kb.row();});}
    kb.row().text('Cancel',callback(d,'cancel'));
    await ctx.db.setState(ctx.userId,'guided_form',d as unknown as Record<string,unknown>);
    await ctx.api.sendRichMessage(ctx.chat!.id,{blocks:[{type:'heading',size:3,text:`Review ${title[d.kind].toLowerCase()}`},...(error?[{type:'paragraph' as const,text:error}]:[]),reportTable(['Detail','Value'],rows),{type:'footer',text:d.kind==='transfer'?'Records money you already moved. Transfers are neither income nor spending.':d.kind==='bill'?`Reminders use ${ctx.tz}. Confirm only after paying; no automatic charges or expenses.`:'Review these settings before saving.'}]},{reply_markup:kb});return;
  }
  let prompt=field.hint??'Choose below or type your answer.';
  if(field.type==='money'){
    d.buffer??=d.values[field.key]??'';
    prompt=`${d.buffer||'0'} AMD\n${prompt}\nYou can also type the amount.`;
    for(const row of [['1','2','3'],['4','5','6'],['7','8','9']]){for(const key of row)kb.text(key,callback(d,'digit:'+key));kb.row();}
    if(!field.whole)kb.text('.',callback(d,'digit:dot'));
    kb.text('0',callback(d,'digit:0')).text('⌫',callback(d,'digit:back')).row().text('Clear',callback(d,'digit:clear')).text('Use amount',callback(d,'amount')).row();
  }else if(field.type==='choice')for(const [label,value]of field.choices!)kb.text(label,callback(d,`v:${d.index}:${value}`)).row();
  else if(field.type==='account'){
    const accounts=(await ctx.db.accounts.list(ctx.userId,todayIn(ctx.tz))).filter(a=>!a.archived&&!(field.key==='destination'&&a.id===Number(d.values.source)));
    for(const a of accounts)kb.text(`${a.name} · ${minorMoney(a.balance_minor,ctx.sign)}`,callback(d,`v:${d.index}:${a.id}`)).row();
    if(!accounts.length)prompt='Create an account to continue. Your draft will stay in Drafts.';
    kb.text('New account','setup:account:new').row();
  }else if(field.type==='category'){
    for(const c of await ctx.db.categories(ctx.userId))kb.text(c.name,callback(d,`v:${d.index}:${c.id}`)).row();
  }else if(field.type==='date'){
    kb.text('Today',callback(d,`v:${d.index}:${todayIn(ctx.tz)}`)).text(field.future?'Tomorrow':'Yesterday',callback(d,`v:${d.index}:${addDays(todayIn(ctx.tz),field.future?1:-1)}`)).row();prompt='Choose a date or type YYYY-MM-DD.';
  }else if(field.type==='time')for(const value of ['09:00','12:00','18:00'])kb.text(value,callback(d,`v:${d.index}:${value}`));
  if(field.optional)kb.row().text('Skip',callback(d,`v:${d.index}:skip`));
  if(d.editing)kb.row().text('Back to review',callback(d,'review'));else if(d.index>0)kb.row().text('Back',callback(d,'back'));
  kb.row().text('Cancel',callback(d,'cancel'));
  await ctx.db.setState(ctx.userId,'guided_form',d as unknown as Record<string,unknown>);
  const text=`<b>${title[d.kind]} · ${escapeHtml(field.title)}</b>\n<i>${d.editing?'Edit details':`Step ${d.index+1} of ${list.length}`}</i>\n\n${error?escapeHtml(error)+'\n\n':''}${escapeHtml(prompt)}`;
  if(ctx.callbackQuery?.message?.text){try{await ctx.editMessageText(text,{parse_mode:'HTML',reply_markup:kb});}catch(error){if(!(error instanceof Error)||!/not modified/.test(error.message))throw error;}}
  else await ctx.reply(text,{parse_mode:'HTML',reply_markup:kb});
}
async function accept(ctx:AppContext,d:FormDraft,value:string):Promise<void>{
  const field=fields(d)[d.index];if(!field)return;
  if(field.optional&&value==='skip')value='';
  let error='';
  if(!value&&!field.optional)error='This field is required.';
  else if(value&&field.type==='money'&&(parseMinor(value,field.zero)===null||field.whole&&parseMinor(value)!%100!==0))error=field.whole?'Enter a positive whole AMD amount.':'Enter a valid amount with at most two decimal places.';
  else if(value&&field.type==='date'&&(!validDate(value)||!field.future&&value>todayIn(ctx.tz)||d.kind==='goal'&&value<todayIn(ctx.tz)))error='Choose a valid date for this field.';
  else if(field.type==='text'&&value.length>(field.max??120))error=`Use at most ${field.max??120} characters.`;
  else if(d.kind==='goal'&&field.key==='label'&&!/^[\p{L}\p{N} _-]{1,40}$/u.test(value))error='Use letters, numbers, spaces, underscores or hyphens for a goal name.';
  else if(field.type==='choice'&&!field.choices!.some(c=>c[1]===value))error='Choose one of these options.';
  else if(field.type==='time'&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))error='Use HH:MM, for example 09:00.';
  else if(field.type==='account'){
    const a=await ctx.db.accounts.get(ctx.userId,Number(value));if(!a||a.archived||field.key==='destination'&&value===d.values.source)error='Choose an active, different account.';
  }else if(value&&field.type==='category'){
    const c=await ctx.db.category(ctx.userId,Number(value));if(!c||c.archived)error='Choose an active category.';
  }
  if(error){await showForm(ctx,d,error);return;}
  d.values[field.key]=value;d.buffer=undefined;
  if(d.editing){d.editing=false;const missing=fields(d).findIndex(f=>!f.optional&&!d.values[f.key]);d.index=missing>=0?missing:fields(d).length;}else d.index++;
  await showForm(ctx,d);
}
async function save(ctx:AppContext,d:FormDraft){
  const v=d.values,event=`form:${ctx.userId}:${d.request}`,day=todayIn(ctx.tz);
  if(d.kind==='account')await dashboardAction(ctx.db,ctx.env.DB,ctx.userId,ctx.tz,{action:d.id?'account-edit':'account-create',requestId:d.request,id:d.id,version:d.version,label:v.label,opening:v.opening,openingOn:v.openingOn,passive:v.passive==='true',archived:v.archived==='true'});
  else if(d.kind==='goal'){
    const target=parseMinor(v.target??''),opening=parseMinor(v.opening??'',true),daily=v.plan==='daily'?parseMinor(v.daily??''):null,deadline=v.plan==='deadline'?v.deadline:null,cap=v.cap?parseMinor(v.cap):null;
    if(target===null||opening===null||v.plan==='daily'&&daily===null||v.plan==='deadline'&&(!deadline||!validDate(deadline)||deadline<day)||v.cap&&cap===null)throw new Error('Check the goal amounts and target date.');
    if(d.id){const result=await ctx.env.DB.prepare('UPDATE goals SET target_minor=?,opening_minor=?,daily_minor=?,deadline=?,cap_minor=? WHERE user_id=? AND id=? AND version=?').bind(target,opening,daily,deadline??null,cap,ctx.userId,d.id,d.version).run();if(!result.meta.changes)throw new Error('This goal changed. Reopen it.');}
    else {
      const result=await ctx.env.DB.prepare(`INSERT INTO goals(user_id,name,target_minor,deadline,daily_minor,opening_minor,cap_minor)
        SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM goals WHERE user_id=? AND lower(name)=lower(?))`)
        .bind(ctx.userId,v.label!,target,deadline??null,daily,opening,cap,ctx.userId,v.label!).run();
      if(!result.meta.changes)throw new Error('A goal already uses that name. Open /goal to edit it.');
    }
  }else if(d.kind==='transfer')await ctx.db.transfers.add(ctx.userId,Number(v.source),Number(v.destination),parseMinor(v.amount??'')??0,v.day!,v.note??'',event,day);
  else await ctx.db.bills.save(ctx.userId,{label:v.label!,amount_minor:parseMinor(v.amount??'')??0,account_id:Number(v.accountId),category_id:v.categoryId?Number(v.categoryId):null,frequency:v.frequency as 'weekly'|'monthly',next_due:v.nextDue!,remind_time:v.time!,enabled:v.enabled==='false'?0:1},event,d.id,d.version);
}
financeForms.command('account',async(ctx,next)=>{if(ctx.match.trim())return next();await start(ctx,'account');});
financeForms.command('goal',async(ctx,next)=>{if(ctx.match.trim()||(await ctx.db.finance.goals(ctx.userId)).length)return next();await start(ctx,'goal');});
financeForms.command('transfer',ctx=>start(ctx,'transfer'));
financeForms.command('bill',ctx=>start(ctx,'bill'));
financeForms.callbackQuery(/^setup:(account|goal|bill):(new|\d+)$/,async ctx=>{await ctx.answerCallbackQuery();await start(ctx,ctx.match[1] as FormKind,ctx.match[2]==='new'?undefined:Number(ctx.match[2]));});
financeForms.callbackQuery('setup:transfer:new',async ctx=>{await ctx.answerCallbackQuery();await start(ctx,'transfer');});
financeForms.callbackQuery(/^f:([a-f0-9]{32}):(.+)$/,async ctx=>{
  await ctx.answerCallbackQuery();const d=await active(ctx);if(!d||token(d)!==ctx.match[1]){await ctx.reply('This form is no longer active. Use /resume for saved drafts.');return;}
  const action=ctx.match[2]!;
  if(action==='cancel'){await ctx.db.clearState(ctx.userId);await ctx.reply('Form closed. Existing records are unchanged.');return;}
  if(d.blocked){await showForm(ctx,d,'Check your records before starting another attempt.');return;}
  if(action==='save'){
    if(d.index<fields(d).length)return;
    try{await save(ctx,d);}catch(error){
      const recovery=entryRecovery(error);
      d.blocked=!recovery.retrySafe;
      const message=error instanceof Error&&/^(Choose|Enter|Use |This |A goal|An account|Account changed|Check the|Bill amounts|The opening)/.test(error.message)?error.message:recovery.message;
      await showForm(ctx,d,message);return;
    }
    await ctx.db.clearState(ctx.userId);
    const kb=new InlineKeyboard().text('Continue a draft','drafts:list').text('Add entry','entry:new');
    await ctx.reply(d.kind==='transfer'?'Transfer recorded. Both account balances are updated.':`${title[d.kind]} saved.`,{reply_markup:kb});return;
  }
  if(action==='back'){d.index=Math.max(0,d.index-1);d.buffer=undefined;}
  else if(action==='review'){d.index=fields(d).length;d.editing=false;d.buffer=undefined;}
  else if(action.startsWith('edit:')){const i=Number(action.slice(5));if(!fields(d)[i])return;d.index=i;d.editing=true;d.buffer=undefined;}
  else if(action.startsWith('v:')){const [step,...rest]=action.slice(2).split(':');if(Number(step)!==d.index)return;await accept(ctx,d,rest.join(':'));return;}
  else if(action==='amount'){if(fields(d)[d.index]?.type==='money')await accept(ctx,d,d.buffer??'');return;}
  else if(action.startsWith('digit:')){
    const field=fields(d)[d.index];if(field?.type!=='money')return;const key=action.slice(6);let value=d.buffer??'';
    if(key==='clear')value='';else if(key==='back')value=value.slice(0,-1);else if(key==='dot'&&!field.whole&&!value.includes('.'))value=(value||'0')+'.';else if(/^\d$/.test(key)&&value.length<15&&(!value.includes('.')||value.split('.')[1]!.length<2))value=(value==='0'?'':value)+key;
    if(value===d.buffer)return;d.buffer=value;
  }
  await showForm(ctx,d);
});
financeForms.on('message:text',async(ctx,next)=>{if(ctx.message.text.startsWith('/'))return next();const d=await active(ctx);if(!d)return next();if(d.index>=fields(d).length){await showForm(ctx,d,'Use the buttons to edit a field or save.');return;}await accept(ctx,d,ctx.message.text.trim());});
