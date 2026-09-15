import { describe, expect, it } from 'vitest';
import { createBot } from '../src/bot';
import { testDb } from './sqlite';
import { todayIn } from '../src/lib/dates';
import type { Env } from '../src/types';

const envFor = (d1: Env['DB']): Env => ({DB:d1,BOT_TOKEN:'test',BOT_INFO:JSON.stringify({id:99,is_bot:true,first_name:'Test',username:'test'}),ALLOWED_USER_IDS:'1',DEFAULT_TZ:'Asia/Yerevan',CURRENCY:'AMD',CURRENCY_SIGN:'֏',WEBHOOK_SECRET:'test'});

describe('/add channel workflow', () => {
  it('asks for an account and then creates a daily channel table', async () => {
    const {db,d1}=testDb(); await db.ensureUser(1); await db.accounts.create(1,'Card',0,todayIn('Asia/Yerevan'),'setup');
    await db.finance.link(-1001,1,'Diary'); const sent:any[]=[];
    const bot=createBot(envFor(d1),{waitUntil:()=>{}}); bot.api.config.use(async (prev,next,payload)=>{sent.push({method:next,payload}); if(next==='sendMessage')return {ok:true,result:{message_id:44,date:1,chat:{id:-1001}}} as never; return {ok:true,result:true} as never;});
    const update=(id:number,text:string)=>({update_id:id,message:{message_id:id,date:Math.floor(Date.now()/1000),from:{id:1,is_bot:false,first_name:'User'},chat:{id:1,type:'private' as const,first_name:'User'},text,entities:[{type:'bot_command' as const,offset:0,length:text.split(' ')[0]!.length}]}});
    await bot.handleUpdate(update(1,'/add metro 150'));
    expect(sent.some(x=>x.payload?.reply_markup?.inline_keyboard?.flat().some((b:any)=>String(b.callback_data).startsWith('addaccount:')))).toBe(true);
    await bot.handleUpdate({update_id:2,callback_query:{id:'q',from:{id:1,is_bot:false,first_name:'User'},chat_instance:'x',data:'addaccount:1',message:{message_id:10,date:1,chat:{id:1,type:'private' as const},text:'pick'}}} as any);
    const message=sent.find(x=>x.method==='sendRichMessage'&&x.payload?.chat_id===-1001); expect(message?.payload?.rich_message?.blocks?.[1]?.type).toBe('table'); expect(JSON.stringify(message?.payload?.rich_message)).toContain('metro @ Card'); expect(JSON.stringify(message?.payload?.rich_message)).toContain('150');
  });
  it('edits an existing source post in place and preserves its existing rows', async () => {
    const {db,d1}=testDb(); await db.ensureUser(1); await db.accounts.create(1,'Card',0,todayIn('Asia/Yerevan'),'setup'); await db.finance.link(-1001,1,'Diary');
    await db.finance.syncPost(1,-1001,77,1,1,todayIn('Asia/Yerevan'),[{categoryId:null,label:'coffee',amount:200,accountId:1}],null);
    const calls:any[]=[];const bot=createBot(envFor(d1),{waitUntil:()=>{}}); bot.api.config.use(async (prev,next,payload)=>{calls.push({method:next,payload});return {ok:true,result:true} as never;});
    await bot.handleUpdate({update_id:2,message:{message_id:2,date:Math.floor(Date.now()/1000),from:{id:1,is_bot:false,first_name:'User'},chat:{id:1,type:'private' as const},text:'/add metro 150 @ Card',entities:[{type:'bot_command' as const,offset:0,length:4}]}} as any);
    const edit=calls.find(x=>x.method==='editMessageText');expect(edit?.payload?.chat_id).toBe(-1001);expect(edit?.payload?.message_id).toBe(77);expect(edit?.payload?.rich_message?.blocks?.[1]?.type).toBe('table');expect(JSON.stringify(edit?.payload?.rich_message)).toContain('coffee @ Card');expect(JSON.stringify(edit?.payload?.rich_message)).toContain('metro @ Card');expect(JSON.stringify(edit?.payload?.rich_message)).toContain('Total: 350');
  });
  it('creates an account from a channel row and does not count it as spending', async()=>{
    const {db,d1}=testDb();await db.ensureUser(1);await db.finance.link(-1001,1,'Diary');const bot=createBot(envFor(d1),{waitUntil:()=>{}});bot.api.config.use(async()=>({ok:true,result:true} as never));
    await bot.handleUpdate({update_id:1,channel_post:{message_id:1,date:Math.floor(Date.now()/1000),chat:{id:-1001,type:'channel' as const,title:'Diary'},text:`${todayIn('Asia/Yerevan')}\nItem | price\naccount:Card | 100000\nmetro @ Card | 150\nTotal: 150`}} as any);
    expect((await db.accounts.list(1,todayIn('Asia/Yerevan')))[0]!.name).toBe('Card');expect(await db.totalBetween(1,todayIn('Asia/Yerevan'),todayIn('Asia/Yerevan'))).toBe(150);expect((await db.recentTransactions(1,1))[0]!.account_id).toBe(1);
  });
});
