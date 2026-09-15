import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Env } from '../types';
import { Db } from '../db';
import { DashboardAuth } from './auth';
import { dashboardData } from './data';
import { dashboardAction, ActionError } from './actions';
import { renderDashboard } from './render';
import { monthOf, monthStart, todayIn } from '../lib/dates';

async function body(request: IncomingMessage, limit=16384): Promise<Record<string,unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new ActionError('JSON is required.',415);
  const chunks: Buffer[]=[];
  let size=0;
  for await (const chunk of request) {
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    size+=bytes.length;
    if (size>limit) throw new ActionError('Request too large.',413);
    chunks.push(bytes);
  }
  const text=Buffer.concat(chunks).toString('utf8');
  try {
    const value:unknown=JSON.parse(text);
    if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error();
    return value as Record<string,unknown>;
  } catch { throw new ActionError('Invalid request.'); }
}

export function createDashboardHandler(env: Env) {
  const db=new Db(env.DB,env.DEFAULT_TZ||'Asia/Yerevan');
  const auth=new DashboardAuth(env.DB);
  const origin=env.DASHBOARD_URL?new URL(env.DASHBOARD_URL).origin:null;
  const secure=origin?.startsWith('https:')??false;
  const allowed=new Set(env.ALLOWED_USER_IDS.split(',').map(s=>Number(s.trim())).filter(n=>n>0));
  const cookie=(token:string,age=86400)=>`fintrack_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure?'; Secure':''}`;
  return async (request:IncomingMessage,response:ServerResponse):Promise<void>=> {
    const path=new URL(request.url||'/',origin||'http://localhost');
    response.setHeader('Cache-Control','no-store');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('X-Frame-Options','DENY');
    response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json=(status:number,value:unknown)=> { response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(value)); };
    try {
      if (!origin) { json(404,{error:'Dashboard is not configured.'});return; }
      if (request.method==='GET' && (path.pathname==='/'||path.pathname==='/dashboard')) {
        response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(renderDashboard(null,true));return;
      }
      if (request.method==='POST' && request.headers.origin!==origin) throw new ActionError('Open the dashboard from its configured address.',403);
      if (request.method==='POST' && path.pathname==='/api/session') {
        const input=await body(request);
        const user=await auth.consumeLogin(typeof input.token==='string'?input.token:'');
        if (user===null||!allowed.has(user)) throw new ActionError('This link expired or was already used. Send /dashboard to the bot for a new one.',401);
        const session=await auth.issue(user,'session');
        response.setHeader('Set-Cookie',cookie(session));json(200,{ok:true});return;
      }
      const token=/(?:^|;\s*)fintrack_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie??'')?.[1]??'';
      const user=await auth.session(token);
      if (user===null||!allowed.has(user)) throw new ActionError('Open a new link from /dashboard in your private bot chat.',401);
      if (request.method==='POST'&&path.pathname==='/api/logout') {
        await auth.revoke(token);response.setHeader('Set-Cookie',cookie('',0));json(200,{ok:true});return;
      }
      const tz=await db.ensureUser(user);
      if (request.method==='GET'&&path.pathname==='/api/dashboard') {
        const today=todayIn(tz);
        try { json(200,await dashboardData(db,user,tz,path.searchParams.get('from')||monthStart(monthOf(today)),path.searchParams.get('to')||today)); }
        catch(error) { throw new ActionError(error instanceof Error?error.message:'Could not load dashboard.'); }
        return;
      }
      if (request.method==='GET'&&path.pathname==='/api/history') {const before=Number(path.searchParams.get('before'))||Number.MAX_SAFE_INTEGER;json(200,await db.workspace.history(user,before));return;}
      if (request.method==='GET'&&/^\/api\/attachment\/\d+$/.test(path.pathname)) {
        const item=await env.DB.prepare('SELECT name,mime,data FROM entry_attachments WHERE user_id=? AND id=?').bind(user,Number(path.pathname.split('/').at(-1))).first<{name:string;mime:string;data:string|null}>();
        if(!item?.data){json(404,{error:'Receipt not found.'});return;}
        response.writeHead(200,{'Content-Type':item.mime,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(item.name)});response.end(Buffer.from(item.data,'base64'));return;
      }
      if (request.method==='POST'&&(path.pathname==='/api/action'||path.pathname==='/api/attachment')) {
        const input=await body(request,path.pathname==='/api/attachment'?1200000:16384);
        if(path.pathname==='/api/attachment'&&input.action!=='attachment-add')throw new ActionError('Invalid attachment action.');
        const result=await dashboardAction(db,env.DB,user,tz,input);json(200,{ok:true,result});return;
      }
      json(404,{error:'Not found.'});
    } catch(error) {
      json(error instanceof ActionError?error.status:500,{error:error instanceof ActionError?error.message:'Could not complete the request. Refresh and try again.'});
    }
  };
}
