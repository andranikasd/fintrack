import type { Db } from '../db';
import { WorkspaceDb, WorkspaceError } from '../workspace-db';
import { addDays, monthEnd } from '../lib/dates';
import { parseMinor, validDate } from '../lib/savings';
export const workspaceActions=new Set(['rule-preview','rule-save','rule-delete','history-undo','view-save','view-delete','logging-day','logging-month','balance-check','month-close','month-reopen','attachment-add','attachment-delete']);
function text(value:unknown,max=120){if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new WorkspaceError(`Enter text of 1–${max} characters.`);return value.trim();}
function id(value:unknown){if(!Number.isSafeInteger(value)||Number(value)<1)throw new WorkspaceError('Invalid record.');return Number(value);}
export async function workspaceAction(db:Db,w:WorkspaceDb,user:number,today:string,body:Record<string,unknown>){
 const period=body.period;
 if(period!==undefined&&(typeof period!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)||period>today.slice(0,7)))throw new WorkspaceError('Choose the current month or an earlier month.');
 switch(body.action){
  case 'rule-preview':case 'rule-save':{
   const labels=text(body.labels,4000).split('\n').map(s=>s.trim()).filter(Boolean);
   if(labels.length>40||labels.some(s=>s.length>120))throw new WorkspaceError('Use up to 40 spelling variations, at most 120 characters each.');
   const category=await db.category(user,id(body.categoryId));if(!category||category.archived)throw new WorkspaceError('Choose an active category.');
   if(body.action==='rule-preview'){const {records,...preview}=await w.rulePreview(user,labels,category.id);return preview;}
   if(!Number.isSafeInteger(body.revision))throw new WorkspaceError('Preview this rule before saving.');
   await w.applyRule(user,labels,category.id,Number(body.revision),body.applyHistory===true,String(body.fingerprint||''));return;
  }
  case 'rule-delete': await w.sql.prepare('DELETE FROM aliases WHERE user_id=? AND label=? COLLATE NOCASE').bind(user,text(body.label)).run();return;
  case 'history-undo':await w.undo(user,id(body.id));return;
  case 'view-save':{
   const settings=body.settings as Record<string,unknown>;
   if(!settings||typeof settings!=='object')throw new WorkspaceError('Missing view settings.');
   const allowed=['search','kind','category','account','passive','group','chart','series','rangeMode','days','from','to'];const clean:Record<string,string>={};
   for(const key of allowed)if(settings[key]!==undefined){if(typeof settings[key]!=='string'||settings[key].length>200)throw new WorkspaceError('Invalid view settings.');clean[key]=settings[key];}
   if(!['month','days','fixed'].includes(clean.rangeMode??'')||!['bars','lines','cumulative'].includes(clean.chart??''))throw new WorkspaceError('Choose a date mode and chart type.');
   if(clean.rangeMode==='days'&&(!/^\d+$/.test(clean.days??'')||Number(clean.days)<1||Number(clean.days)>366))throw new WorkspaceError('Choose 1–366 days.');
   if(clean.rangeMode==='fixed'&&(!validDate(clean.from??'')||!validDate(clean.to??'')||clean.from!>clean.to!||clean.to!>today||Date.parse(clean.to!)-Date.parse(clean.from!)>365*86400000))throw new WorkspaceError('Choose valid fixed dates.');
   await w.sql.prepare('INSERT INTO saved_views(user_id,name,settings) VALUES(?,?,?) ON CONFLICT(user_id,name) DO UPDATE SET settings=excluded.settings').bind(user,text(body.label,60),JSON.stringify(clean)).run();return;
  }
  case 'view-delete':await w.sql.prepare('DELETE FROM saved_views WHERE user_id=? AND id=?').bind(user,id(body.id)).run();return;
  case 'logging-day':{
   const day=text(body.day);if(!validDate(day)||day>today)throw new WorkspaceError('Choose today or an earlier day.');
   const revision=await w.revision(user);
   if(body.status==='no-spend'&&await db.totalBetween(user,day,day)>0)throw new WorkspaceError('This day has expenses. Mark logging complete instead.');
   if(body.status==='clear')await w.sql.prepare('DELETE FROM logging_days WHERE user_id=? AND day=?').bind(user,day).run();
   else{if(!['complete','no-spend'].includes(String(body.status)))throw new WorkspaceError('Choose a logging status.');await w.guarded(user,revision,[w.sql.prepare('INSERT INTO logging_days(user_id,day,status) VALUES(?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET status=excluded.status').bind(user,day,body.status)]);}return;
  }
  case 'logging-month':{
   if(typeof period!=='string')throw new WorkspaceError('Choose a month.');const revision=await w.revision(user),end=monthEnd(period)>today?today:monthEnd(period),statements=[];
   for(let day=period+'-01';day<=end;day=addDays(day,1))statements.push(w.sql.prepare("INSERT INTO logging_days(user_id,day,status) VALUES(?,?,'complete') ON CONFLICT(user_id,day) DO NOTHING").bind(user,day));
   await w.guarded(user,revision,statements);return;
  }
  case 'balance-check':{
   if(typeof period!=='string')throw new WorkspaceError('Choose a month.');const account=await db.accounts.get(user,id(body.accountId));if(!account)throw new WorkspaceError('Account not found.');
   const raw=text(body.amount),negative=raw.startsWith('-'),amount=parseMinor(negative?raw.slice(1):raw,true);if(amount===null)throw new WorkspaceError('Enter a valid account balance.');
   await w.sql.prepare('INSERT INTO balance_checks(user_id,period,account_id,actual_minor) VALUES(?,?,?,?) ON CONFLICT(user_id,period,account_id) DO UPDATE SET actual_minor=excluded.actual_minor').bind(user,period,account.id,negative?-amount:amount).run();return;
  }
  case 'month-close':{
   if(typeof period!=='string')throw new WorkspaceError('Choose a month.');const revision=await w.revision(user),closing=await w.closing(db,user,period,today);
   if(!closing.ready)throw new WorkspaceError('Resolve the checklist, confirm each day and check account balances after the month ends.');
   if(closing.fingerprint!==body.fingerprint)throw new WorkspaceError('The checklist changed. Refresh it before closing.');
   await w.guarded(user,revision,[w.sql.prepare("INSERT INTO month_reviews(user_id,period,fingerprint) VALUES(?,?,?) ON CONFLICT(user_id,period) DO UPDATE SET fingerprint=excluded.fingerprint,reviewed_at=datetime('now')").bind(user,period,closing.fingerprint)]);return;
  }
  case 'month-reopen':await w.sql.prepare('DELETE FROM month_reviews WHERE user_id=? AND period=?').bind(user,text(period)).run();return;
  case 'attachment-add':{
   const entry=await w.entry(user,String(body.kind),id(body.id));const note=typeof body.note==='string'?body.note.trim():'';if(note.length>2000)throw new WorkspaceError('Notes can have at most 2,000 characters.');
   let content:string|null=null,mime='text/plain',name='Note';
   if(body.data){content=text(body.data,1100000);mime=text(body.mime,60);name=text(body.name,120);
    if(!['image/jpeg','image/png','application/pdf'].includes(mime)||!/^[A-Za-z0-9+/]+={0,2}$/.test(content)||content.length%4)throw new WorkspaceError('Use a JPEG, PNG or PDF receipt.');
    const decoded=atob(content);if(decoded.length>750000)throw new WorkspaceError('Receipt exceeds 750 KB. Choose a smaller file.');
    const valid=mime==='image/jpeg'?decoded.startsWith('\xff\xd8\xff'):mime==='image/png'?decoded.startsWith('\x89PNG\r\n\x1a\n'):decoded.startsWith('%PDF-');if(!valid)throw new WorkspaceError('Receipt content does not match its file type.');
   }
   if(!content&&!note)throw new WorkspaceError('Add a receipt or a note.');
   await w.sql.prepare('INSERT INTO entry_attachments(user_id,entry_key,name,mime,data,note,event_key) VALUES(?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING').bind(user,entry.key,name,mime,content,note,`attachment:${user}:${body.requestId}`).run();return;
  }
  case 'attachment-delete':await w.sql.prepare('DELETE FROM entry_attachments WHERE user_id=? AND id=?').bind(user,id(body.id)).run();return;
 }
}
